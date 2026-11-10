//! Private JSON-lines entry point for client-executed Codex dynamic tools.

use std::collections::BTreeMap;

use anyhow::{Context, Result, bail};
use fastctx::server::FastCtxServer;
use rmcp::model::{CallToolRequestParams, CallToolResult, RequestId, Tool};
use rmcp::service::RequestContext;
use rmcp::{RoleServer, ServerHandler};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::io::{AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tokio::task::JoinSet;

use crate::protocol::{FrameReader, ProtocolFrame, ProtocolLimits};

const MAX_IN_FLIGHT: usize = 16;
const MAX_ID_BYTES: usize = 256;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: String,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ToolCall {
    name: String,
    #[serde(default)]
    arguments: Map<String, Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cancel {
    request_id: String,
}

#[derive(Serialize)]
struct ToolList {
    tools: Vec<Tool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CancelResult {
    request_id: String,
    status: &'static str,
}

#[derive(Serialize)]
struct NativeError {
    message: &'static str,
}

#[derive(Serialize)]
#[serde(untagged)]
enum Payload {
    Call { result: CallToolResult },
    List { result: ToolList },
    Cancel { result: CancelResult },
    Error { error: NativeError },
    HandlerError { error: rmcp::ErrorData },
}

#[derive(Serialize)]
struct Reply<'a, I: ?Sized> {
    id: &'a I,
    #[serde(flatten)]
    payload: Payload,
}

struct PendingCall {
    context: RequestContext<RoleServer>,
    cancellable: bool,
}

enum Input {
    Frame(ProtocolFrame),
    End,
    Error(std::io::Error),
}

/// Runs one cwd/environment-bound worker without an external MCP connection.
pub async fn run() -> Result<()> {
    let limits = ProtocolLimits::from_environment();
    let server = FastCtxServer::new();
    // The typed handler needs a Peer even for file tools which never use it.
    // Keep an idle in-memory peer solely as context; tool calls bypass its transport.
    let (transport, _peer_transport) = tokio::io::duplex(1);
    let service =
        rmcp::service::serve_directly::<RoleServer, _, _, _, _>(server.clone(), transport, None);
    let peer = service.peer().clone();
    let (input_tx, mut input_rx) = mpsc::channel(1);
    let input_task = tokio::spawn(async move {
        let mut stdin = BufReader::new(tokio::io::stdin());
        let frames = FrameReader::new(limits);
        loop {
            let input = match frames.read_line(&mut stdin).await {
                Ok(Some(frame)) => Input::Frame(frame),
                Ok(None) => Input::End,
                Err(error) => Input::Error(error),
            };
            let finished = !matches!(input, Input::Frame(_));
            if input_tx.send(input).await.is_err() || finished {
                return;
            }
        }
    });
    let mut stdout = tokio::io::stdout();
    let mut tasks = JoinSet::new();
    let mut pending = BTreeMap::<String, PendingCall>::new();
    let mut input_open = true;
    let outcome: Result<()> = async {
        loop {
            tokio::select! {
                completed = tasks.join_next(), if !tasks.is_empty() => {
                    let (id, response) = completed.context("FastCtx native task missing")?
                        .context("FastCtx native tool task failed")?;
                    pending.remove(&id);
                    write_response(&mut stdout, &id, response, limits).await?;
                }
                input = input_rx.recv(), if input_open => {
                    let frame = match input {
                        Some(Input::Frame(frame)) => frame,
                        Some(Input::Error(error)) => return Err(error).context("FastCtx native input failed"),
                        Some(Input::End) | None => {
                            input_open = false;
                            continue;
                        }
                    };
                    let request = match serde_json::from_slice::<Request>(&frame) {
                        Ok(request) if valid_id(&request.id) => request,
                        _ => {
                            write_response(&mut stdout, &Value::Null, error("Invalid native request"), limits).await?;
                            continue;
                        }
                    };
                    if pending.contains_key(&request.id) {
                        // A second response for the same id could be mistaken for an in-flight write.
                        bail!("FastCtx native rejected a duplicate in-flight request id");
                    }
                    match request.method.as_str() {
                        "tools/list" => {
                            let response = if request.params.is_null() || request.params.as_object().is_some_and(Map::is_empty) {
                                Payload::List { result: ToolList { tools: server.tool_definitions() } }
                            } else {
                                error("tools/list does not accept parameters")
                            };
                            write_response(&mut stdout, &request.id, response, limits).await?;
                        }
                        "tools/call" => {
                            let call = match serde_json::from_value::<ToolCall>(request.params) {
                                Ok(call) if matches!(call.name.as_str(), "inspect_local_file" | "grep" | "glob" | "replace" | "delete" | "move" | "create_file") => call,
                                _ => {
                                    write_response(&mut stdout, &request.id, error("Invalid or unsupported native tool call"), limits).await?;
                                    continue;
                                }
                            };
                            if pending.len() >= MAX_IN_FLIGHT.min(limits.max_pending_requests) {
                                write_response(&mut stdout, &request.id, error("FastCtx native in-flight request limit reached"), limits).await?;
                                continue;
                            }
                            let context = RequestContext::new(RequestId::String(request.id.clone().into()), peer.clone());
                            pending.insert(request.id.clone(), PendingCall {
                                context: context.clone(),
                                cancellable: matches!(call.name.as_str(), "grep" | "glob"),
                            });
                            let server = server.clone();
                            tasks.spawn(async move {
                                let call = CallToolRequestParams::new(call.name).with_arguments(call.arguments);
                                let response = match server.call_tool(call, context).await {
                                    Ok(result) => Payload::Call { result },
                                    Err(error) => Payload::HandlerError { error },
                                };
                                (request.id, response)
                            });
                        }
                        "cancel" => {
                            let response = match serde_json::from_value::<Cancel>(request.params) {
                                Ok(cancel) if valid_id(&cancel.request_id) => {
                                    let status = match pending.get(&cancel.request_id) {
                                        Some(call) if call.cancellable => {
                                            call.context.ct.cancel();
                                            "cancellationRequested"
                                        }
                                        Some(_) => "notCancellable",
                                        None => "notRunning",
                                    };
                                    Payload::Cancel { result: CancelResult { request_id: cancel.request_id, status } }
                                }
                                _ => error("Invalid cancel parameters"),
                            };
                            write_response(&mut stdout, &request.id, response, limits).await?;
                        }
                        _ => write_response(&mut stdout, &request.id, error("Unsupported native method"), limits).await?,
                    }
                }
                else => break,
            }
        }
        Ok(())
    }.await;
    input_task.abort();
    let _ = input_task.await;
    for call in pending.values() {
        if call.cancellable {
            call.context.ct.cancel();
        }
    }
    // Reads and writes cannot be interrupted safely; await them without replaying.
    while tasks.join_next().await.is_some() {}
    service
        .cancel()
        .await
        .context("Closing FastCtx native context failed")?;
    outcome
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_ID_BYTES && !id.chars().any(char::is_control)
}

fn error(message: &'static str) -> Payload {
    Payload::Error {
        error: NativeError { message },
    }
}

async fn write_response<W, I>(
    writer: &mut W,
    id: &I,
    payload: Payload,
    limits: ProtocolLimits,
) -> Result<()>
where
    W: AsyncWrite + Unpin,
    I: serde::Serialize + ?Sized,
{
    let mut response = Reply { id, payload };
    let mut bytes = serde_json::to_vec(&response)?;
    if bytes.len() >= limits.max_frame_bytes {
        response.payload = error("FastCtx native response exceeds the frame limit");
        bytes = serde_json::to_vec(&response)?;
    }
    bytes.push(b'\n');
    writer
        .write_all(&bytes)
        .await
        .context("Writing FastCtx native response failed")?;
    writer
        .flush()
        .await
        .context("Flushing FastCtx native response failed")
}
