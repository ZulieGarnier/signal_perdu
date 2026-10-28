(function () {
  'use strict';
  var SUGGESTIONS = [
    'Un objet que j’emporterais sur une île déserte',
    'Mon lieu préféré pour créer',
    'Mon poste de travail idéal',
    'Un animal qui fait un métier surprenant',
    'Le repas de fête le plus étrange du monde',
    'Une rue de ma ville dans 100 ans'
  ];
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var LS = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };

  var ws = null, V = null, offset = 0, key = '', autoSent = '', pendingJoin = null, selected = null, shownStep = -1, shownAlbum = -1, galleryAlbum = 0;
  var qroom = (new URLSearchParams(location.search).get('room') || '').toUpperCase().slice(0, 4);
  var token = LS.get('sp_token');
  if (!token) { token = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(function (b) { return b.toString(16).padStart(2, '0'); }).join(''); LS.set('sp_token', token); }

  function toast(m) { var t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(function () { t.hidden = true; }, 4500); }
  function mmss(s) { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60); }
  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

  /* ---------- connexion ---------- */
  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.onopen = function () {
      var saved = LS.get('sp_room');
      var name = LS.get('sp_name');
      if (saved && name && (!qroom || qroom === saved)) send({ t: 'join', room: saved, name: name, token: token });
      else if (!V) render();
    };
    ws.onmessage = function (e) {
      var m = JSON.parse(e.data);
      if (m.t === 'state') { V = m; offset = m.now - Date.now(); LS.set('sp_room', m.room); render(); }
      else if (m.t === 'error') { toast(m.m); if (!V) { LS.set('sp_room', ''); render(); } }
      else if (m.t === 'kicked') { V = null; LS.set('sp_room', ''); render(); toast('Tu as été retiré de la salle.'); }
    };
    ws.onclose = function () { $('#sub').textContent = 'Connexion perdue, reconnexion…'; setTimeout(connect, 1500); };
  }

  /* ---------- rendu ---------- */
  function header() {
    var ph = $('#phase'), sub = $('#sub');
    if (!V) { ph.hidden = true; sub.textContent = 'On transmet un prompt d’image en image, et on regarde ce que le signal devient.'; return; }
    ph.hidden = false;
    var label = { lobby: 'Salle ' + V.room, play: 'Tour ' + (V.round + 1) + ' / ' + V.rounds, reveal: 'Révélation', gallery: 'Galerie' }[V.phase];
    ph.textContent = label;
    sub.textContent = { lobby: 'Prépare-toi à jouer.', play: 'Tout le monde joue en même temps.', reveal: 'On dévoile les albums, un par un.', gallery: 'Tous les albums, en libre accès.' }[V.phase];
    $('#timer').hidden = V.phase !== 'play';
  }

  function render() {
    header();
    var box = $('#screen'), k;
    if (!V) k = 'home';
    else if (V.phase === 'lobby') k = 'lobby';
    else if (V.phase === 'play') { var t = V.task; k = t ? 'play:' + V.round + ':' + t.album + ':' + t.type + ':' + t.done : 'watch:' + V.round; }
    else k = V.phase;
    if (k !== key) { key = k; selected = null; build(k); }
    update(k);
  }

  function build(k) {
    var box = $('#screen'), h = '';
    if (k === 'home') {
      var n = LS.get('sp_name') || '';
      h = '<section class="card"><p class="eyebrow">Bienvenue</p><h2>' + (qroom ? 'Rejoindre la salle ' + esc(qroom) : 'Lancer ou rejoindre une partie') + '</h2>' +
        '<p class="lead">Un prompt circule d’un joueur à l’autre : tu génères une image, un autre la décrit, un autre la régénère… et on découvre ce que le signal est devenu.</p>' +
        '<div class="field"><label for="pseudo">Pseudo</label><input type="text" id="pseudo" maxlength="24" autocomplete="nickname" value="' + esc(n) + '"></div>' +
        (qroom ? '' : '<div class="field"><label for="rcode">Code de salle (pour rejoindre)</label><input type="text" id="rcode" maxlength="4" autocapitalize="characters" placeholder="ABCD"></div>') +
        '<div class="actions">' + (qroom ? '<button class="btn primary" data-act="join">Rejoindre</button>' : '<button class="btn primary" data-act="join">Rejoindre avec le code</button><button class="btn" data-act="create">Créer une salle</button>') + '</div></section>';
    } else if (k === 'lobby') {
      h = '<section class="card"><p class="eyebrow">Salle d’attente</p><p class="code" id="code"></p><p class="muted">Les joueurs ouvrent le lien ci-dessous ou saisissent le code.</p>' +
        '<div class="actions"><input type="text" id="link" readonly style="max-width:420px"><button class="btn small" data-act="copy">Copier le lien</button></div>' +
        '<h3>Joueurs</h3><ul class="chips" id="plist"></ul><p class="muted" id="plmeta"></p></section>' +
        '<section class="card" id="settings" hidden><p class="eyebrow">Animateur</p><h2>Régler la partie</h2>' +
        '<div class="row"><div class="field"><label for="s-rounds">Nombre de tours</label><input type="number" id="s-rounds" min="2" max="16" value="4"></div>' +
        '<div class="field"><label for="s-w">Écrire (secondes)</label><input type="number" id="s-w" min="20" max="600" value="90"></div>' +
        '<div class="field"><label for="s-i">Générer (secondes)</label><input type="number" id="s-i" min="30" max="600" value="120"></div>' +
        '<div class="field"><label for="s-d">Décrire (secondes)</label><input type="number" id="s-d" min="20" max="600" value="90"></div></div>' +
        '<div class="field"><label for="s-style">Consigne de style ajoutée à chaque image (facultatif)</label><input type="text" id="s-style" maxlength="200" placeholder="ex. illustration, couleurs vives, sans texte"></div>' +
        '<label><input type="checkbox" id="s-play" checked> Je joue aussi (sinon je supervise seulement)</label>' +
        '<p class="muted">Chaque joueur écrit un prompt de départ ; chaque album passe ensuite entre toutes les mains en alternant image et description. Par défaut, autant de tours que de joueurs.</p>' +
        '<div class="actions"><button class="btn primary" data-act="start" id="btnStart">Lancer la partie</button><button class="btn" data-act="addbot">Ajouter un joueur test</button></div><p class="muted">Pour t’entraîner seule : les joueurs test jouent automatiquement (images factices). Toi seule génères de vraies images.</p></section>';
    } else if (k.indexOf('play:') === 0) {
      var t = V.task, done = t.done, ty = t.type;
      h = '<section class="card" id="taskcard"><p class="eyebrow" id="steplabel"></p>';
      if (done) {
        h += '<h2>C’est envoyé</h2><p class="lead" id="waittxt"></p>' + (t.lastRound ? '<p class="muted">C’était le dernier tour : la révélation arrive.</p>' : '<div class="field"><label for="ctext">En attendant : ajoute un élément que le prochain joueur devra intégrer</label><input type="text" id="ctext" maxlength="80" placeholder="ex. un parapluie jaune, une ambiance de nuit, un clown…"><div class="actions"><button class="btn" data-act="constraint">Envoyer cet élément</button><span class="muted" id="cstate"></span></div></div>');
      } else if (ty === 'write') {
        h += '<h2>Écris ton prompt de départ</h2><p class="muted">C’est le début de ton album : un autre joueur va devoir en faire une image. Une phrase précise et visuelle marche le mieux.</p>' +
          '<div class="field"><label for="ptext">Ton prompt</label><textarea id="ptext" maxlength="700" placeholder="Un sujet, un lieu, une lumière, un style…"></textarea></div>' +
          '<div class="suggest" id="sugg"></div>' +
          '<div class="actions"><button class="btn primary" data-act="sendtext">Envoyer mon prompt</button></div>';
      } else if (ty === 'image') {
        h += '<h2>Transforme ce prompt en image</h2>' + recvPromptHTML(t) +
          '<div id="own"></div>' +
          '<div class="field" id="xfield"><label for="xtext">Ajoute un élément à ce prompt (facultatif)</label><input type="text" id="xtext" maxlength="80" placeholder="ex. un parapluie jaune, une lumière de coucher de soleil…"></div>' +
          '<div class="actions"><button class="btn primary" data-act="gen" id="btnGen">Générer l’image</button><span class="muted" id="attempts"></span></div>' +
          '<p class="error" id="gerr"></p><div class="cands" id="cands"></div>' +
          '<div class="actions"><button class="btn primary" data-act="sendimg" id="btnSend" disabled>Envoyer cette image</button></div>';
      } else {
        h += '<h2>Décris cette image par un prompt</h2>' + recvImageHTML(t) +
          '<div class="field"><label for="ptext">Le prompt qui permettrait de la recréer</label><textarea id="ptext" maxlength="700" placeholder="Sujet, lieu, lumière, style, cadrage… (30 à 50 mots)"></textarea></div>' +
          '<div class="actions"><button class="btn primary" data-act="sendtext">Envoyer mon prompt</button></div>';
      }
      h += '</section><section class="card"><h3>Qui a envoyé ?</h3><ul class="chips" id="prog"></ul></section>';
    } else if (k.indexOf('watch:') === 0) {
      h = '<section class="card"><p class="eyebrow">Partie en cours</p><h2>Tu observes cette manche</h2><ul class="chips" id="prog"></ul></section>';
    } else if (k === 'reveal') {
      shownStep = -1; shownAlbum = -1;
      h = '<section class="card"><p class="eyebrow" id="rev-eyebrow"></p><h2 id="rev-title"></h2></section><div id="steps" style="display:flex;flex-direction:column;gap:20px"></div><div id="hostbar"></div>';
    } else if (k === 'gallery') {
      h = '<section class="card"><p class="eyebrow">Galerie</p><h2>Tous les albums</h2><div class="pills" id="pills"></div></section><div id="gal" style="display:flex;flex-direction:column;gap:20px"></div><div id="hostbar"></div>';
    }
    box.innerHTML = h;
    if (k.indexOf('play:') === 0 && V.task) {
      var ct = $('#ctext'); if (ct) ct.value = V.task.myConstraint || '';
      var s = $('#sugg'); if (s) { s.innerHTML = SUGGESTIONS.map(function (x, i) { return '<button type="button" data-act="sugg" data-i="' + i + '">' + esc(x) + '</button>'; }).join(''); }
      var own = $('#own');
      if (own && !(V.task.recv && !V.task.recv.skipped && V.task.recv.text)) own.innerHTML = '<div class="field"><label for="ptext">Aucun prompt reçu : écris le tien</label><textarea id="ptext" maxlength="700"></textarea></div>';
    }
  }

  function constraintHTML(r, hint) {
    return r && r.constraint ? '<p class="badge">Élément imposé par le joueur précédent : « ' + esc(r.constraint) + ' » (' + hint + ')</p>' : '';
  }
  function recvPromptHTML(t) {
    var r = t.recv;
    if (r && !r.skipped && r.text) return '<p class="muted">Prompt reçu (utilise-le tel quel)</p><blockquote class="quote">' + esc(r.text) + '</blockquote>' + constraintHTML(r, 'sera ajouté automatiquement à la génération');
    return '<p class="badge">Le joueur précédent n’a rien envoyé.</p>';
  }
  function recvImageHTML(t) {
    var r = t.recv;
    if (r && r.url) return '<div class="imgbox big"><img src="' + esc(r.url) + '" alt="Image à décrire"></div>' + constraintHTML(r, 'à intégrer dans ton prompt');
    return '<p class="badge">Le joueur précédent n’a pas envoyé d’image. Écris un prompt de ton choix.</p>';
  }

  function update(k) {
    if (!V) return;
    if (k === 'lobby') {
      $('#code').textContent = V.room;
      var l = $('#link'); if (l && l.value !== location.origin + '/?room=' + V.room) l.value = location.origin + '/?room=' + V.room;
      var np = V.players.filter(function (p) { return p.connected; }).length;
      $('#plist').innerHTML = V.players.map(function (p) {
        return '<li class="chip' + (p.connected ? '' : ' off') + '">' + esc(p.name) + (p.id === V.me ? ' (toi)' : '') + (p.host ? ' · animateur' : '') + (p.bot ? ' · test' : '') +
          (V.host && p.id !== V.me ? '<button class="x" data-act="kick" data-id="' + esc(p.id) + '" aria-label="Retirer ' + esc(p.name) + '">×</button>' : '') + '</li>';
      }).join('');
      $('#plmeta').textContent = np + ' joueur' + (np > 1 ? 's' : '') + ' connecté' + (np > 1 ? 's' : '') + (V.host ? '' : ' · l’animateur lancera la partie.');
      $('#settings').hidden = !V.host;
      var r = $('#s-rounds'); if (r && !r.dataset.touched) { r.value = Math.max(2, np); r.max = Math.max(2, np); }
      if (r && !r.dataset.bound) { r.dataset.bound = 1; r.addEventListener('input', function () { r.dataset.touched = 1; }); }
      var b = $('#btnStart'); if (b) b.disabled = np < 2;
    } else if (k.indexOf('play:') === 0) {
      var t = V.task;
      $('#steplabel').textContent = 'Album ' + (t.album + 1) + ' · étape ' + (t.round + 1) + ' sur ' + V.rounds;
      $('#prog').innerHTML = V.players.filter(function (p) { return p.playing; }).map(function (p) { return '<li class="chip' + (p.done ? ' done' : '') + '">' + esc(p.name) + (p.done ? ' ✓' : '') + '</li>'; }).join('');
      if (t.done) { var n = V.players.filter(function (p) { return p.done; }).length, tot = V.players.filter(function (p) { return p.playing; }).length; var cs = $('#cstate'); if (cs) cs.textContent = V.task.myConstraint ? 'Envoyé : « ' + V.task.myConstraint + ' »' : '';
        $('#waittxt').textContent = n + ' joueur' + (n > 1 ? 's ont' : ' a') + ' envoyé sur ' + tot + '. Le tour suivant démarre dès que tout le monde a terminé, ou à la fin du temps.'; }
      if (t.type === 'image' && !t.done) {
        var c = $('#cands');
        var sig = t.candidates.map(function (x) { return x.id; }).join(',') + '|' + selected + '|' + t.busy;
        if (c.dataset.sig !== sig) {
          c.dataset.sig = sig;
          if (!selected || !t.candidates.some(function (x) { return x.id === selected; })) selected = t.candidates.length ? t.candidates[t.candidates.length - 1].id : null;
          c.innerHTML = t.candidates.map(function (x, i) { return '<button class="cand" data-act="pick" data-id="' + x.id + '" aria-pressed="' + (x.id === selected) + '" aria-label="Choisir l’image ' + (i + 1) + '"><div class="imgbox"><img src="' + esc(x.url) + '" alt="Image générée ' + (i + 1) + '"></div></button>'; }).join('') +
            (t.busy ? '<div class="imgbox"><span class="ph"><span class="spin"></span>Génération en cours…</span></div>' : '');
        }
        $('#btnGen').disabled = t.busy || t.attempts >= t.maxAttempts;
        $('#btnGen').textContent = t.candidates.length ? 'Générer une autre version' : 'Générer l’image';
        if (t.candidates.length && t.maxAttempts === 1) { $('#btnGen').hidden = true; var xf = $('#xfield'); if (xf) xf.hidden = true; }
        $('#attempts').textContent = t.maxAttempts === 1 ? 'Une seule génération par tour : fais-la compter.' : (t.maxAttempts - t.attempts) + ' essai(s) restant(s)';
        $('#gerr').textContent = t.error || '';
        $('#btnSend').disabled = !selected;
      }
    } else if (k.indexOf('watch:') === 0) {
      $('#prog').innerHTML = V.players.filter(function (p) { return p.playing; }).map(function (p) { return '<li class="chip' + (p.done ? ' done' : '') + '">' + esc(p.name) + (p.done ? ' ✓' : '') + '</li>'; }).join('');
    } else if (k === 'reveal') {
      var al = V.albums[V.reveal.album], st = V.reveal.step;
      $('#rev-eyebrow').textContent = 'Album ' + (V.reveal.album + 1) + ' sur ' + V.albums.length;
      $('#rev-title').textContent = 'Album lancé par ' + al.owner;
      var box = $('#steps');
      if (shownAlbum !== V.reveal.album || st < shownStep) { box.innerHTML = ''; shownStep = -1; }
      for (var i = shownStep + 1; i <= st; i++) { var d = document.createElement('div'); d.innerHTML = stepHTML(al, i, true); box.appendChild(d.firstChild); }
      if (st !== shownStep || shownAlbum !== V.reveal.album) { var last = box.lastElementChild; if (last && shownStep >= 0 && last.scrollIntoView) last.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      shownStep = st; shownAlbum = V.reveal.album;
      hostBar(al, st);
    } else if (k === 'gallery') {
      galleryAlbum = Math.min(galleryAlbum, V.albums.length - 1);
      $('#pills').innerHTML = V.albums.map(function (a, i) { return '<button data-act="album" data-i="' + i + '" aria-pressed="' + (i === galleryAlbum) + '">' + esc(a.owner) + '</button>'; }).join('');
      var g = V.albums[galleryAlbum], html = '';
      for (var j = 0; j < g.steps.length; j++) html += stepHTML(g, j, false);
      var sig2 = galleryAlbum + ':' + g.steps.length;
      if ($('#gal').dataset.sig !== sig2) { $('#gal').dataset.sig = sig2; $('#gal').innerHTML = html; }
      hostBar(null, 0);
    }
  }

  function stepHTML(al, i, anim) {
    var st = al.steps[i], tag = i === 0 ? '<span class="tag">Départ</span>' : (i === al.steps.length - 1 ? '<span class="tag">Arrivée</span>' : '');
    if (!st) return '<article class="card step"><p class="badge">Étape manquante.</p></article>';
    var body = st.type === 'image'
      ? '<div class="imgbox">' + (st.url ? '<img src="' + esc(st.url) + '" alt="Image de l’étape ' + (i + 1) + '">' : '<span class="ph">Pas d’image</span>') + '</div>'
      : '';
    var right = st.type === 'image'
      ? '<p class="who">' + esc(st.author) + ' a généré cette image' + tag + '</p>' + (st.extra ? '<p class="badge">Élément ajouté au prompt : « ' + esc(st.extra) + ' »</p>' : '') + (st.skipped ? '<p class="badge">Rien n’a été généré à temps.</p>' : '')
      : '<p class="who">' + esc(st.author) + (i === 0 ? ' a écrit le prompt de départ' : ' a décrit l’image') + tag + '</p>' + (st.skipped ? '<p class="badge">Pas de prompt à temps.</p>' : '<blockquote class="quote">' + esc(st.text) + '</blockquote>');
    if (st.constraint) right += '<p class="badge">Élément imposé au joueur suivant : « ' + esc(st.constraint) + ' »</p>';
    return '<article class="card step' + (anim ? ' in' : '') + '">' + (body || '<div></div>') + '<div style="display:flex;flex-direction:column;gap:12px;min-width:0">' + right + '</div></article>';
  }

  function hostBar(al, st) {
    var hb = $('#hostbar'); if (!hb) return;
    if (!V.host) { hb.innerHTML = ''; return; }
    var h = '<section class="card hostbar"><p class="eyebrow">Animateur</p><div class="actions">';
    if (V.phase === 'reveal') {
      var lastStep = st >= al.steps.length - 1, lastAlbum = V.reveal.album >= V.albums.length - 1;
      h += '<button class="btn" data-act="rprev"' + (V.reveal.album === 0 && st === 0 ? ' disabled' : '') + '>Précédent</button>' +
        '<button class="btn primary" data-act="rnext">' + (!lastStep ? 'Étape suivante' : (!lastAlbum ? 'Album suivant' : 'Ouvrir la galerie')) + '</button>' +
        '<button class="btn" data-act="rgal">Aller à la galerie</button>';
    }
    h += '<button class="btn" data-act="again">Nouvelle partie</button></div></section>';
    if (hb.dataset.sig !== h) { hb.dataset.sig = h; hb.innerHTML = h; }
  }

  /* ---------- actions ---------- */
  function sendText() {
    var ta = $('#ptext'); send({ t: 'submit', text: ta ? ta.value : '' });
  }
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]'); if (!el) return;
    var a = el.getAttribute('data-act');
    if (a === 'join' || a === 'create') {
      var name = ($('#pseudo').value || '').trim(); if (!name) { toast('Choisis un pseudo.'); return; }
      LS.set('sp_name', name);
      if (a === 'create') send({ t: 'create', name: name, token: token });
      else { var code = qroom || (($('#rcode') || {}).value || '').trim().toUpperCase(); if (code.length !== 4) { toast('Saisis le code à 4 lettres.'); return; } send({ t: 'join', room: code, name: name, token: token }); }
    } else if (a === 'copy') { var l = $('#link'); l.select(); try { navigator.clipboard.writeText(l.value).then(function () { toast('Lien copié.'); }, function () { toast('Copie le lien sélectionné.'); }); } catch (x) { toast('Copie le lien sélectionné.'); } }
    else if (a === 'addbot') send({ t: 'addbot' });
    else if (a === 'constraint') { var ci = $('#ctext'); send({ t: 'constraint', text: ci ? ci.value : '' }); toast('Élément envoyé.'); }
    else if (a === 'kick') send({ t: 'kick', id: el.getAttribute('data-id') });
    else if (a === 'start') {
      send({ t: 'start', settings: { rounds: +$('#s-rounds').value, secWrite: +$('#s-w').value, secImage: +$('#s-i').value, secDescribe: +$('#s-d').value, style: $('#s-style').value, hostPlays: $('#s-play').checked } });
    } else if (a === 'sugg') { var ta = $('#ptext'); if (ta) { ta.value = SUGGESTIONS[+el.getAttribute('data-i')]; ta.focus(); } }
    else if (a === 'sendtext') sendText();
    else if (a === 'gen') { var own = $('#own textarea'), xt = $('#xtext'); send({ t: 'generate', prompt: own ? own.value : '', extra: xt ? xt.value : '' }); }
    else if (a === 'pick') { selected = el.getAttribute('data-id'); var c = $('#cands'); if (c) c.dataset.sig = ''; update(key); }
    else if (a === 'sendimg') send({ t: 'submit', imageId: selected });
    else if (a === 'rnext') send({ t: 'reveal', a: 'next' });
    else if (a === 'rprev') send({ t: 'reveal', a: 'prev' });
    else if (a === 'rgal') send({ t: 'reveal', a: 'gallery' });
    else if (a === 'album') { galleryAlbum = +el.getAttribute('data-i'); update(key); }
    else if (a === 'again') { var hb = $('#hostbar'); if (el.dataset.sure) send({ t: 'again' }); else { el.dataset.sure = 1; el.textContent = 'Confirmer : nouvelle partie'; setTimeout(function () { el.dataset.sure = ''; el.textContent = 'Nouvelle partie'; }, 4000); } }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target && e.target.id === 'pseudo') { var b = document.querySelector('[data-act="join"]'); if (b) b.click(); } });

  /* ---------- minuteur et envoi automatique ---------- */
  setInterval(function () {
    if (!V || V.phase !== 'play') return;
    var left = (V.endsAt - (Date.now() + offset)) / 1000, tm = $('#timer');
    tm.textContent = mmss(left); tm.classList.toggle('late', left <= 10);
    var t = V.task;
    if (t && !t.done && left <= 0) {
      var id = V.round + ':' + t.album;
      if (autoSent !== id) {
        autoSent = id;
        if (t.type === 'image') send({ t: 'submit', imageId: selected }); else sendText();
      }
    }
  }, 250);

  connect(); render();
})();
