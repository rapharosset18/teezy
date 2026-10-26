/*
 * Stand-in for the design tool's runtime, so the mocks render in a plain browser.
 * Supports what the mocks use: <x-dc>/<helmet>, <sc-for list as>, <sc-if value>,
 * {{path}} in text and attributes, on* handlers, and a Component with
 * renderVals() and setState(). It's for viewing the designs, not for the app.
 */
(function () {
  'use strict';

  var component = null;
  var template = [];
  var root = null;

  window.DCLogic = function DCLogic(props) {
    this.props = props || {};
    this.state = {};
  };
  window.DCLogic.prototype.setState = function (patch) {
    Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
    render();
  };

  function lookup(scope, expr) {
    expr = expr.trim();
    if (expr === 'true') return true;
    if (expr === 'false') return false;
    return expr.split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, scope);
  }

  // A value that is exactly one {{binding}} keeps its type (lists, functions, booleans).
  function interp(str, scope) {
    var whole = str.match(/^\s*\{\{([^}]*)\}\}\s*$/);
    if (whole) return lookup(scope, whole[1]);
    return str.replace(/\{\{([^}]*)\}\}/g, function (_, e) {
      var v = lookup(scope, e);
      return v == null ? '' : String(v);
    });
  }

  function truthy(v) {
    return !!v && v !== 'false';
  }

  function renderChildren(node, scope, out) {
    Array.prototype.forEach.call(node.childNodes, function (c) { renderNode(c, scope, out); });
  }

  function renderNode(node, scope, out) {
    if (node.nodeType === 3) {
      out.appendChild(document.createTextNode(interp(node.nodeValue, scope)));
      return;
    }
    if (node.nodeType !== 1) return;
    var tag = node.localName;
    if (tag === 'script' || tag === 'helmet') return;
    if (tag === 'sc-for') {
      var list = interp(node.getAttribute('list'), scope) || [];
      var as = node.getAttribute('as');
      list.forEach(function (item) {
        var s = Object.create(scope);
        s[as] = item;
        renderChildren(node, s, out);
      });
      return;
    }
    if (tag === 'sc-if') {
      if (truthy(interp(node.getAttribute('value'), scope))) renderChildren(node, scope, out);
      return;
    }
    var el = document.createElementNS(node.namespaceURI, node.localName);
    Array.prototype.forEach.call(node.attributes, function (a) {
      if (a.name.indexOf('hint-') === 0) return;
      if (/^on[a-z]+$/.test(a.name) && a.value.indexOf('{{') !== -1) {
        var fn = interp(a.value, scope);
        // React-style onChange fires on every keystroke.
        var type = a.name === 'onchange' ? 'input' : a.name.slice(2);
        if (typeof fn === 'function') el.addEventListener(type, fn);
        return;
      }
      var v = interp(a.value, scope);
      if (v == null || v === false) return;
      if (a.name === 'value' && 'value' in el) el.value = String(v);
      el.setAttribute(a.name, v === true ? '' : String(v));
    });
    renderChildren(node, scope, el);
    out.appendChild(el);
  }

  // Path of child indexes from root, to put focus back after a re-render.
  function pathTo(el) {
    var path = [];
    while (el && el !== root) {
      path.unshift(Array.prototype.indexOf.call(el.parentNode.childNodes, el));
      el = el.parentNode;
    }
    return el === root ? path : null;
  }

  function render() {
    var active = document.activeElement;
    var focusPath = active && root.contains(active) ? pathTo(active) : null;
    var caret = focusPath && 'selectionStart' in active ? active.selectionStart : null;
    var vals = component.renderVals ? component.renderVals() : {};
    var frag = document.createDocumentFragment();
    template.forEach(function (n) { renderNode(n, vals, frag); });
    root.replaceChildren(frag);
    if (focusPath) {
      var el = focusPath.reduce(function (n, i) { return n && n.childNodes[i]; }, root);
      if (el && el.focus) {
        el.focus();
        if (caret != null && el.setSelectionRange) el.setSelectionRange(caret, caret);
      }
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    var host = document.querySelector('x-dc') || document.body;
    var helmet = host.querySelector('helmet');
    if (helmet) Array.prototype.slice.call(helmet.children).forEach(function (c) { document.head.appendChild(c); });
    template = Array.prototype.slice.call(host.childNodes).filter(function (n) { return n !== helmet; });
    template.forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
    root = host;

    var script = document.querySelector('script[type="text/x-dc"]');
    var Component = script ? new Function('DCLogic', script.textContent + '\nreturn Component;')(window.DCLogic) : null;
    component = Component ? new Component({}) : { renderVals: function () { return {}; } };
    render();
  });
})();
