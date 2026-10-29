// Injected into vidlink's player page when couch serves it from its screen
// subdomain. Blocks ad pop-ups and lets the couch room page drive the player.

(function () {
  // Pop-ups: ad scripts open new windows, click hidden target=_blank links, or
  // borrow a fresh window.open from a blank iframe they create. The Worker
  // already refuses to serve the ad libraries; this is the second line.
  window.open = function () { return null; };
  const frameWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow");
  Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
    get: function () {
      const w = frameWindow.get.call(this);
      try {
        if (w) w.open = function () { return null; };
      } catch (error) {} // a cross-origin frame can't be patched, and can't be borrowed from either
      return w;
    },
  });
  const realClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.target === "_blank") return;
    return realClick.call(this);
  };
  document.addEventListener("click", function (event) {
    const link = event.target.closest && event.target.closest("a[target=_blank]");
    if (link) event.preventDefault();
  }, true);

  // Commands from the room page.
  const ROOM_ORIGINS = ["https://couch.nicktrim.com", "http://localhost:8787"];
  window.addEventListener("message", function (event) {
    if (!ROOM_ORIGINS.includes(event.origin)) return;
    const command = event.data;
    if (!command || command.type !== "COUCH_COMMAND" || !window.jwplayer) return;
    const p = window.jwplayer();
    if (!p || !p.getState) return;
    if (command.seek !== undefined) p.seek(command.seek);
    if (command.play === true) p.play();
    if (command.play === false) p.pause();
    if (command.unmute) {
      p.setMute(false);
      if (p.getVolume() === 0) p.setVolume(100);
    }
  });
})();
