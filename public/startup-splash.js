(() => {
  if (
    !/\/index\.html$/i.test(location.pathname) ||
    new URLSearchParams(location.search).has("initialRoute") ||
    window.__codeyStartupSplashInstalled
  ) return;
  const markup = __CODEY_STARTUP_SPLASH__;
  const readySelector = [
    "[data-app-navigation-rail]",
    "[data-app-action-sidebar-scroll]",
    'main:has(button, a[href], input, textarea, [contenteditable="true"])',
    "form:has(button, input)",
    '[role="alert"]:not(:empty)',
  ].join(", ");
  let splash = null;
  let frame = 0;
  const isReady = (root) => root && !root.querySelector(".startup-loader") &&
    root.getAttribute("aria-busy") !== "true" &&
    [...root.querySelectorAll(readySelector)].some((element) =>
      !element.closest('[hidden], [aria-hidden="true"], [aria-busy="true"]') &&
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility === "visible");
  const dispose = () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
    document.removeEventListener("DOMContentLoaded", update);
    window.removeEventListener("pagehide", dispose);
    splash?.removeEventListener("animationend", finish);
    splash?.remove();
    // Startup :has() rules must not keep invalidating styles after the splash exits.
    document.getElementById("codey-startup-splash-style")?.remove();
  };
  const finish = (event) => {
    if (event.target !== splash || event.animationName !== "codey-splash-exit") return;
    dispose();
  };
  const update = () => {
    const root = document.getElementById("root");
    if (!root) {
      if (document.readyState !== "loading") dispose();
      return;
    }
    if (!splash) {
      splash = document.querySelector(".codey-splash");
      if (root.parentElement !== document.body || (!splash && isReady(root))) {
        dispose();
        return;
      }
      if (!splash) {
        const template = document.createElement("template");
        template.innerHTML = markup;
        root.before(template.content);
        splash = document.querySelector(".codey-splash");
      }
      if (getComputedStyle(splash).visibility === "hidden") {
        dispose();
        return;
      }
      splash.dataset.codeySplashManaged = "true";
      splash.addEventListener("animationend", finish);
    }
    if (!splash.isConnected) {
      dispose();
      return;
    }
    if (!isReady(root)) {
      cancelAnimationFrame(frame);
      frame = 0;
      delete splash.dataset.codeySplashReady;
      return;
    }
    // React can replace the static loader before its first usable screen paints.
    if (!frame && !splash.dataset.codeySplashReady) {
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (isReady(document.getElementById("root"))) splash.dataset.codeySplashReady = "true";
        });
      });
    }
  };
  const observer = new MutationObserver(update);
  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "aria-hidden", "aria-busy"],
  });
  document.addEventListener("DOMContentLoaded", update, { once: true });
  window.addEventListener("pagehide", dispose, { once: true });
  window.__codeyStartupSplashInstalled = true;
  update();
})();
