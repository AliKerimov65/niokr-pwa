// Supabase конфигурация — подключено
const SUPABASE_URL = 'https://lxgipzdybigdpdcmcnez.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_xWP4N5YGxb2B9Lmo_tJ19Q_X-LtmqJw';

/* ============================================================================
 * ПАТЧ v104 (2026-09-14, Эксперт) — восстановление раздела «Акты АОСР».
 *
 * Диагноз аудита:
 *  1) Таблица acts УДАЛЕНА из базы (REST 404) — акты не сохранялись вообще.
 *  2) В v103 список актов не загружался при входе в раздел
 *     (ACTS инициализирован как [], а загрузка шла только при ACTS === null).
 *
 * Решение без DDL и без правки index.html: акты хранятся как JSON-файлы
 * в Supabase Storage (бакет files, папка acts/<team_id>/) — та же
 * межустройная синхронизация в реальном времени. Ниже — безопасное
 * переопределение четырёх функций после загрузки основного кода.
 * При следующей полной правке index.html — вшить в основной код
 * и убрать отсюда (подробности: PATCH-v104.md).
 * ========================================================================== */
(function(){
  function applyPatch(){
    var ActsStore = {
      prefix: function(){ return 'acts/' + tid(); },
      load: async function(){
        try{
          var r1 = await sb.storage.from('files').list(this.prefix(), {limit: 500});
          if(r1.error) throw r1.error;
          var out = [];
          for(var i = 0; i < (r1.data || []).length; i++){
            var o = r1.data[i];
            if(!o.name || !o.name.endsWith('.json')) continue;
            try{
              var url = sb.storage.from('files').getPublicUrl(this.prefix() + '/' + o.name).data.publicUrl;
              var r = await fetch(url + '?t=' + Date.now(), {cache: 'no-store'});
              if(r.ok){ var j = await r.json(); if(j && typeof j.num === 'number') out.push(j); }
            }catch(_){}
          }
          out.sort(function(a,b){ return a.num - b.num; });
          return out;
        }catch(e){ console.warn('Акты: ошибка загрузки —', e && e.message); return []; }
      },
      save: async function(row){
        var id = Date.now();
        var act = Object.assign({}, row, {id: id, created_at: new Date().toISOString()});
        var body = new Blob([JSON.stringify(act)], {type: 'application/json'});
        var r = await sb.storage.from('files').upload(this.prefix() + '/' + id + '.json', body, {contentType: 'application/json', upsert: true});
        if(r.error) throw r.error;
        return act;
      },
      remove: async function(id){
        var r = await sb.storage.from('files').remove([this.prefix() + '/' + id + '.json']);
        if(r.error) throw r.error;
      }
    };
    window.ActsStore = ActsStore;

    window.loadActs = async function(){
      if(!SYNC){ ACTS = []; return; }
      ACTS = await ActsStore.load();
    };

    var _renderActs = renderActs;
    window.renderActs = function(v){
      if(!SYNC){ _renderActs(v); return; }
      v.innerHTML = '<h2 class="pt">📄 Акты и документы</h2><p class="mut">Загрузка…</p>';
      loadActs().then(function(){ if(view === 'acts') _renderActs(v); });
    };

    window.actSave = async function(){
      var w = ACT_WORKS[parseInt($('#acW').value)];
      var num = (ACTS.length ? Math.max.apply(null, ACTS.map(function(a){ return a.num; })) : 0) + 1;
      var row = {
        team_id: tid(), num: num,
        work_name: w.name,
        basis_project: w.section,
        basis_quality: w.doc,
        date_act: $('#acD').value || null, date_from: $('#acFrom').value || null, date_to: $('#acTo').value || null,
        conclusion: $('#acConc').value,
        rep_customer: $('#acCust').value || null, rep_contractor: $('#acContr').value || null,
        rep_designer: $('#acDes').value || null, rep_control: $('#acCtrl').value || null,
        attach: $('#acAttach').value || null, created_by: me.name
      };
      try{ await ActsStore.save(row); }
      catch(e){ return alert('Не удалось сохранить акт: ' + (e.message || e)); }
      $('#overlay').style.display = 'none';
      ACTS = null; render();
    };

    window.actDel = async function(id){
      if(!confirm('Удалить акт?')) return;
      try{ await ActsStore.remove(id); }
      catch(e){ return alert('Не удалось удалить акт: ' + (e.message || e)); }
      ACTS = null; render();
    };

    console.info('[v104] Патч актов применён: хранение АОСР в Supabase Storage');
  }

  var tries = 0;
  (function poll(){
    if(typeof actSave === 'function' && typeof renderActs === 'function' &&
       typeof sb !== 'undefined' && sb && typeof tid === 'function'){
      applyPatch();
    } else if(++tries < 120){
      setTimeout(poll, 250);
    }
  })();
})();
