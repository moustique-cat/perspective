// The smallest possible stand-in for the design tool's component runtime, used ONLY by the
// tests: it lets the original artboard file run in a plain browser page, markup and script
// untouched, so the built site can be compared with it pixel for pixel.
// It does three things: fills {{ value }} holes from renderVals(), expands <sc-for>, and wires
// React-style event attributes. Nothing here ships to the site.
(function () {
  'use strict';
  var HOLE = /\{\{\s*([\w.$]+)\s*\}\}/g;
  var ONE = /^\s*\{\{\s*([\w.$]+)\s*\}\}\s*$/;
  var EVT = { onwheel: 'wheel', onclick: 'click', onchange: 'input', onkeydown: 'keydown', onpointerdown: 'pointerdown', onpointermove: 'pointermove', onpointerup: 'pointerup', onpointercancel: 'pointercancel' };

  function look(scope, p) {
    var v = scope, ks = p.split('.'), i;
    for (i = 0; i < ks.length; i++) { if (v == null) return undefined; v = v[ks[i]]; }
    return v;
  }
  function fill(tpl, scope) {
    return tpl.replace(HOLE, function (_, p) { var v = look(scope, p); return v == null ? '' : String(v); });
  }

  function compile(root, out) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        // do not descend into nested sc-for templates
        var p = n.parentNode;
        while (p && p !== root) { if (p.nodeName === 'SC-FOR') return NodeFilter.FILTER_REJECT; p = p.parentNode; }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var n = root, list = [];
    while (n) { list.push(n); n = walker.nextNode(); }
    list.forEach(function (node) {
      if (node.nodeType === 3) {
        if (node.nodeValue.indexOf('{{') >= 0) {
          (function (tpl, last) {
            out.push(function (scope) { var s = fill(tpl, scope); if (s !== last) { node.nodeValue = s; last = s; } });
          })(node.nodeValue, null);
        }
        return;
      }
      if (node.nodeName === 'SC-FOR' && node !== root) { compileFor(node, out); return; }
      Array.prototype.slice.call(node.attributes || []).forEach(function (a) {
        if (a.value.indexOf('{{') < 0) return;
        var name = a.name, tpl = a.value, lname = name.toLowerCase();
        if (EVT[lname]) {
          var key = tpl.match(ONE)[1], cur = null;
          node.removeAttribute(name);
          node.addEventListener(EVT[lname], function (e) { if (cur) cur(e); }, lname === 'onwheel' ? { passive: true } : undefined);
          out.push(function (scope) { cur = look(scope, key); });
          return;
        }
        var lm = tpl.match(/\{\{\s*v\.(\w+)\.t\s*\}\}/);
        if (lm) node.setAttribute('data-layer', lm[1]); // test hook only: lets tools address a layer by name
        var last = null;
        out.push(function (scope) {
          var s = fill(tpl, scope);
          if (s === last) return;
          last = s;
          if (lname === 'style') node.style.cssText = s;
          else if (lname === 'value' && 'value' in node) { if (document.activeElement !== node) node.value = s; }
          else node.setAttribute(name, s);
        });
      });
    });
  }

  function compileFor(node, out) {
    var key = node.getAttribute('list').match(ONE)[1];
    var as = node.getAttribute('as');
    var proto = document.createDocumentFragment();
    while (node.firstChild) proto.appendChild(node.firstChild);
    node.style.display = 'contents';
    var items = [];
    out.push(function (scope) {
      var arr = look(scope, key) || [], i;
      while (items.length < arr.length) {
        var frag = proto.cloneNode(true), fns = [];
        Array.prototype.slice.call(frag.childNodes).forEach(function (c) { compile(c, fns); });
        node.appendChild(frag);
        items.push(fns);
      }
      for (i = 0; i < arr.length; i++) {
        var sub = Object.create(scope);
        sub[as] = arr[i];
        items[i].forEach(function (f) { f(sub); });
      }
    });
  }

  function DCLogic(props) { this.props = props; this.state = null; }
  DCLogic.prototype.setState = function (u) {
    this.state = Object.assign({}, this.state || {}, u);
    render();
  };

  var Component = new Function('DCLogic', document.getElementById('dc-src').textContent + '\nreturn Component;')(DCLogic);
  var comp = new Component(window.__DC_PROPS);
  // Render first, then mount, as the design tool does (it renders with React): elements enter
  // the document with their real attribute values. Filling the holes in place instead would
  // let the browser style the page once with them empty, and Chromium does not re-resolve
  // color-mix(currentColor ...) when the colour arrives afterwards.
  var root = document.createElement('div');
  root.id = 'root';
  root.appendChild(document.getElementById('dc-template').content.cloneNode(true));
  var binds = [];
  var renders = 0;
  function render() {
    var vals = comp.renderVals();
    for (var i = 0; i < binds.length; i++) binds[i](vals);
    renders++;
  }
  compile(root, binds);
  render();
  document.body.insertBefore(root, document.body.firstChild);
  comp.componentDidMount();

  window.__ref = {
    comp: comp,
    render: render,
    count: function () { return renders; },
    setZ: function (z) { comp.zT = z; comp.jump = null; comp.setState({ z: z, playing: 0 }); },
    setProps: function (p) { Object.assign(comp.props, p); render(); }
  };
})();
