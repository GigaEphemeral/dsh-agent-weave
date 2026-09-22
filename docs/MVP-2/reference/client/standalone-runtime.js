/* Minimal local renderer for Graph Studio's standalone page. */
(function () {
  var root = null;
  var rootView = null;
  var hookState = new Map();
  var current = null;
  var pendingEffects = [];
  var svgTags = new Set(["svg", "g", "path", "rect", "text", "circle", "defs", "marker", "line"]);

  function sameDeps(left, right) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every(function (item, index) { return Object.is(item, right[index]); });
  }

  function flatten(value, out) {
    if (Array.isArray(value)) value.forEach(function (item) { flatten(item, out); });
    else if (value !== null && value !== undefined && value !== false) out.push(value);
    return out;
  }

  function createElement(type, props) {
    return { type: type, props: props || {}, children: flatten(Array.prototype.slice.call(arguments, 2), []) };
  }

  function renderNode(vnode, path, inSvg) {
    if (typeof vnode === "string" || typeof vnode === "number") return document.createTextNode(String(vnode));
    if (!vnode) return document.createTextNode("");
    if (typeof vnode.type === "function") {
      var previous = current;
      current = { path: path, index: 0 };
      var rendered = vnode.type(Object.assign({}, vnode.props, { children: vnode.children }));
      var node = renderNode(rendered, path + ".0", inSvg);
      current = previous;
      return node;
    }
    var svg = inSvg || svgTags.has(vnode.type);
    var node = svg
      ? document.createElementNS("http://www.w3.org/2000/svg", vnode.type)
      : document.createElement(vnode.type);
    Object.keys(vnode.props).forEach(function (name) {
      var value = vnode.props[name];
      if (value === null || value === undefined || name === "key" || name === "children") return;
      if (name === "ref") { value.current = node; return; }
      if (name === "className") { node.setAttribute("class", value); return; }
      if (name === "style" && typeof value === "object") { Object.assign(node.style, value); return; }
      if (name.slice(0, 2) === "on" && typeof value === "function") {
        var eventName = name === "onChange" ? "input" : name.slice(2).toLowerCase();
        node.addEventListener(eventName, value);
        return;
      }
      if (!svg && name in node) {
        try { node[name] = value; return; } catch (_err) { /* fall through */ }
      }
      if (value === true) node.setAttribute(name, "");
      else if (value !== false) node.setAttribute(name, String(value));
    });
    vnode.children.forEach(function (child, index) { node.appendChild(renderNode(child, path + "." + index, svg)); });
    return node;
  }

  function render() {
    pendingEffects = [];
    root.replaceChildren(renderNode(rootView, "0", false));
    pendingEffects.forEach(function (effect) {
      var slot = effect.slot;
      if (typeof slot.cleanup === "function") slot.cleanup();
      slot.cleanup = effect.run() || null;
    });
  }

  function slot(initial) {
    var key = current.path;
    var values = hookState.get(key);
    if (!values) { values = []; hookState.set(key, values); }
    var index = current.index++;
    if (!values[index]) values[index] = initial();
    return values[index];
  }

  window.__React__ = {
    createElement: createElement,
    useState: function (initial) {
      var record = slot(function () { return { value: typeof initial === "function" ? initial() : initial }; });
      return [record.value, function (next) {
        record.value = typeof next === "function" ? next(record.value) : next;
        render();
      }];
    },
    useRef: function (initial) { return slot(function () { return { current: initial }; }); },
    useEffect: function (run, deps) {
      var record = slot(function () { return { deps: undefined, cleanup: null }; });
      if (!sameDeps(record.deps, deps)) {
        record.deps = deps;
        pendingEffects.push({ slot: record, run: run });
      }
    },
  };
  window.__GraphStudioStandalone = {
    mount: function (target, view) { root = target; rootView = view; render(); },
  };

  // 主题跟随：Studio 在 iframe 中，无法继承宿主的 --dsw-alias-* 令牌与 color-scheme。
  // 同域下从父页拷贝令牌（含浅/深变量与 color-scheme），并在宿主主题变化时实时同步。
  // 关键修复：宿主的令牌不一定挂在 documentElement 上——很多 profile 把它放在 <body>
  // 或带 data-theme / data-color-scheme 的包裹层，并靠切换 body 的 class 换肤；
  // 旧实现只读 documentElement 且不观察 body，导致令牌为空、Studio 永远走深色 fallback。
  // 这里从多个候选根合并收集，并额外观察 body 的属性变化。
  function syncHostTheme() {
    try {
      var parentWin = window.parent && window.parent !== window ? window.parent : null;
      if (!parentWin) return;
      var parentDoc = parentWin.document;

      // 候选主题根：documentElement 优先，再补 body 与显式 data-theme/data-color-scheme 包裹层。
      function themeRoots() {
        var roots = [parentDoc.documentElement, parentDoc.body];
        var tagged = parentDoc.querySelector("[data-theme],[data-color-scheme],[data-dsh-theme]");
        if (tagged) roots.push(tagged);
        return roots;
      }

      var applying = false;
      function applyTokens() {
        if (applying) return;
        applying = true;
        try {
          var dst = window.document.documentElement.style;
          var scheme = "";
          themeRoots().forEach(function (root) {
            if (!root) return;
            var cs = parentWin.getComputedStyle(root);
            for (var i = 0; i < cs.length; i++) {
              var name = cs[i];
              if (name.indexOf("--dsw") === 0 || name.indexOf("--dsh") === 0) {
                dst.setProperty(name, cs.getPropertyValue(name));
              }
            }
            if (!scheme) {
              var s = cs.getPropertyValue("color-scheme");
              if (s) scheme = s;
            }
          });
          // 宿主未显式声明 color-scheme 时，退回系统偏好，避免永远深色。
          if (!scheme && parentWin.matchMedia) {
            scheme = parentWin.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
          }
          if (scheme) dst.setProperty("color-scheme", scheme);
        } catch (e) { /* 跨域或读取失败则沿用 fallback 配色 */ }
        finally { applying = false; }
      }

      applyTokens();
      // 令牌可能晚于 iframe 加载才就绪，补一次。
      setTimeout(applyTokens, 300);

      if (typeof MutationObserver !== "undefined") {
        var pending = false;
        function schedule() {
          if (pending) return;
          pending = true;
          setTimeout(function () { pending = false; applyTokens(); }, 120);
        }
        // 三类主题变更都要覆盖：
        // 1) documentElement / body 的内联令牌或 class / data-theme 切换（换肤常见路径）；
        // 2) head 内主题 <style> 被替换。
        [parentDoc.documentElement, parentDoc.body].forEach(function (root) {
          if (!root) return;
          new MutationObserver(schedule).observe(root, { attributes: true });
        });
        if (parentDoc.head) {
          new MutationObserver(schedule).observe(parentDoc.head, {
            childList: true,
            characterData: true,
            subtree: true,
          });
        }
      }
    } catch (e) { /* 独立打开（无父页）则保留 fallback 配色 */ }
  }
  syncHostTheme();

  // 页面级背景/前景：用宿主令牌，缺失时回退到深色 fallback（独立打开场景）。
  var pageStyle = window.document.createElement("style");
  pageStyle.textContent =
    "html,body{margin:0;height:100%;background:var(--dsw-alias-bg-base,#1d2128);" +
    "color:var(--dsw-alias-label-primary,#e8eaed)}#root{height:100%}";
  window.document.head.appendChild(pageStyle);
})();
