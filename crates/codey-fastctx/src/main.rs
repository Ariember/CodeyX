#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

//! FastCtx 工具执行的独立程序，避免 Codey 本体携带文件引擎和分词器常量。

use std::ffi::OsStr;

const CODEY_FASTCTX_NATIVE_ARGUMENT: &str = "--codey-fastctx-native";

fn main() {
    codey_error_log::install_panic_hook("fastctx", "runtime.fastctx_native");
    if let Err(error) = run() {
        let error = format!("{error:#}");
        codey_error_log::record_process_failure_with_recoverability(
            classify_fastctx_failure(&error),
            "run_fastctx_native",
            error.clone(),
            "runtime.fastctx_native",
            false,
        );
        eprintln!("Codey FastCtx 运行失败：{error}");
        std::process::exit(1);
    }
}

fn run() -> anyhow::Result<()> {
    validate_arguments(std::env::args_os())?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(codey_fastctx::native::run());
    // stdio 阻塞读取不能取消，错误退出时不能等待仍打开的 stdin。
    runtime.shutdown_background();
    result
}

fn validate_arguments<I, S>(arguments: I) -> anyhow::Result<()>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut arguments = arguments.into_iter().skip(1);
    anyhow::ensure!(
        arguments.next().as_ref().map(AsRef::as_ref)
            == Some(OsStr::new(CODEY_FASTCTX_NATIVE_ARGUMENT))
            && arguments.next().is_none(),
        "Usage: codey-fastctx --codey-fastctx-native"
    );
    Ok(())
}

fn classify_fastctx_failure(error: &str) -> &'static str {
    let error = error.to_ascii_lowercase();
    if [
        "transport closed",
        "connection closed",
        "unexpectedly closed",
        "broken pipe",
        "stdin read",
        "unexpected eof",
    ]
    .iter()
    .any(|marker| error.contains(marker))
    {
        "fastctx_transport_closed"
    } else {
        "fastctx_process_failed"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_native_entry_argument() {
        assert!(validate_arguments(["codey-fastctx", CODEY_FASTCTX_NATIVE_ARGUMENT]).is_ok());
        for arguments in [
            &[][..],
            &["codey-fastctx"][..],
            &["codey-fastctx", "runtime-bootstrap"][..],
            &["codey-fastctx", "runtime-host"][..],
            &["codey-fastctx", "--help"][..],
            &["codey-fastctx", CODEY_FASTCTX_NATIVE_ARGUMENT, "extra"][..],
        ] {
            assert!(validate_arguments(arguments).is_err(), "{arguments:?}");
        }
    }

    #[test]
    fn transport_failures_are_classified_separately() {
        assert_eq!(
            classify_fastctx_failure("FastCtx native input failed: unexpected EOF"),
            "fastctx_transport_closed"
        );
        assert_eq!(
            classify_fastctx_failure("Writing FastCtx native response failed: broken pipe"),
            "fastctx_transport_closed"
        );
        assert_eq!(
            classify_fastctx_failure("FastCtx native tool task failed"),
            "fastctx_process_failed"
        );
    }
}
