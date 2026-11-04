// Synchronous transport validation has no dependency on the model picker DOM.
(() => {
  window.__codeyCreateModelRequestGate = ({
    nativeSelectionOnly, rewriteRequest, trackRequest, rewriteResult,
  }) => {
    let disposed = false;
    let pending = null;
    const restorers = [];
    const isReady = () => !disposed && (nativeSelectionOnly
      || window.__codeyModelRequestSourceGateInstalled === true || restorers.length === 3);
    const restore = () => {
      for (const undo of restorers.splice(0).reverse()) undo();
    };
    const install = (client) => {
      if (disposed) throw new Error("模型请求校验已重新加载");
      if (!client || client.hostId !== "local") throw new Error("未找到本机模型请求入口");
      const prototype = Object.getPrototypeOf(client);
      const methods = ["enqueueRequest", "createRequest", "onResult"];
      const descriptors = methods.map(name => Object.getOwnPropertyDescriptor(prototype, name));
      if (descriptors.some(descriptor => !descriptor?.writable || typeof descriptor.value !== "function")) {
        throw new Error("当前客户端的模型请求入口不可校验");
      }
      const [enqueue, create, result] = descriptors.map(descriptor => descriptor.value);
      const replacements = [
        function (method, params, ...args) {
          if (this.hostId !== "local" || disposed) return enqueue.call(this, method, params, ...args);
          (window.__codeyAppServerRequestClients ||= new Map()).set(this.hostId, this);
          let request;
          try { request = rewriteRequest(method, params); }
          catch (error) { return Promise.reject(error); }
          return enqueue.call(this, request.method, request.params, ...args);
        },
        function (...args) {
          const created = create.apply(this, args);
          if (this.hostId === "local" && !disposed && created?.request) trackRequest(created.request);
          return created;
        },
        function (id, value, ...args) {
          if (this.hostId === "local" && !disposed) {
            value = rewriteResult(id, this.requestPromises?.get(id)?.method, value);
          }
          return result.call(this, id, value, ...args);
        },
      ];
      try {
        methods.forEach((name, index) => {
          Object.defineProperty(prototype, name, { ...descriptors[index], value: replacements[index] });
          restorers.push(() => {
            if (prototype[name] === replacements[index]) Object.defineProperty(prototype, name, descriptors[index]);
          });
        });
      } catch (error) {
        restore();
        throw error;
      }
      (window.__codeyAppServerRequestClients ||= new Map()).set(client.hostId, client);
      return true;
    };
    return Object.freeze({
      isReady,
      ensure() {
        if (disposed) return Promise.reject(new Error("模型请求校验已重新加载"));
        if (isReady()) return Promise.resolve(true);
        if (pending) return pending;
        pending = Promise.resolve().then(async () => {
          const client = window.__codeyAppServerRequestClients?.get?.("local");
          if (client) return install(client);
          if (typeof window.__codeyLoadCodexRequestClient !== "function") throw new Error("模型请求校验尚未就绪");
          return install(await window.__codeyLoadCodexRequestClient());
        }).finally(() => { pending = null; });
        return pending;
      },
      dispose() {
        disposed = true;
        restore();
      },
    });
  };
})();
