(function () {
  if (window.__mahiear) return;
  var app = document.getElementById('app');
  var box = document.getElementById('unsupported');
  if (!box || (app && app.childNodes.length > 0)) return;
  box.removeAttribute('hidden');
  if (app) app.style.display = 'none';
})();
