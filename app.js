  /* ------------------------- helpers / constants ------------------------- */
  const SO = ['RAJU','HAFID','JOSSY','GC','PARIMIN'];
  /* Urutan kolom tab Sales per Produk (sesuai template) */
  const SO_S7 = ['RAJU','JOSSY','HAFID','GC','PARIMIN'];
  const N  = x => Number(x) || 0;
  // Escape teks biasa untuk ditaruh sebagai konten HTML (mencegah tag/atribut bocor kalau nama produk mengandung < & " dst).
  function escHtml(s){
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  // Escape teks untuk dipakai sebagai literal string JS di dalam atribut onclick="...('...')".
  // Urutan penting: backslash dulu, baru kutip satu; lalu escape untuk konteks atribut HTML (" dan &).
  function escJsAttr(s){
    return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/&/g,'&amp;').replace(/"/g,'&quot;');
  }
  const U  = x => String(x ?? '').trim().toUpperCase();
  /* Normalisasi: PRTIMIN di data → PARIMIN */
  function normSales(s){
    const u = U(s);
    if (u === 'PRTIMIN' || u === 'PARIMIN') return 'PARIMIN';
    return u;
  }
  const rp = x => 'Rp ' + Math.round(N(x)).toLocaleString('id-ID');
  const range = (a,b) => a === b ? rp(a) : rp(a) + ' - ' + rp(b);
  const ROW_H = 34, OVERSCAN = 6;

  const TX_COLS = [
    {k:'no',label:'NO',def:true},{k:'tgl',label:'TANGGAL',def:true},{k:'faktur',label:'NO. FAKTUR',def:true},
    {k:'produk',label:'PRODUK',def:true},{k:'qty',label:'QTY',def:true},{k:'satuan',label:'SATUAN',def:true},
    {k:'hjual',label:'HARGA JUAL',def:true},{k:'hargabeli',label:'HARGA BELI',def:true},{k:'disc',label:'DISC',def:true},
    {k:'total',label:'TOTAL',def:true},{k:'hpp',label:'HPP',def:true},{k:'profit',label:'PROFIT',def:true},
    {k:'sales',label:'SALES',def:true},{k:'bayar',label:'PEMBAYARAN',def:true},
    {k:'customer',label:'CUSTOMER',def:true},{k:'kdcustomer',label:'KODE CUSTOMER',def:true},{k:'alamat',label:'ALAMAT',def:true}
  ];
  let colVis = {}; TX_COLS.forEach(c => colVis[c.k] = c.def);

  /* ------------- module-level state ------------- */
  let rows = [];                       // in-memory fallback master copy
  let filteredRows = [];               // current slice (post-filter, pre-materialise)
  let materialisedRows = [];           // UI-form rows (key 'No. Faktur', 'Produk', ...)
  let R = {};                          // aggregates for KPIs / per-product tabs
  let filters = {month:'',sales:'',product:'',payment:'',dateFrom:'',dateTo:'',kdCustomer:'',q:''};
  let _qsTimer = null;
  function onQuickSearchInput(){
    clearTimeout(_qsTimer);
    _qsTimer = setTimeout(() => { applyFilters(); }, 300);
  }
  // Pencarian cepat hanya mencocokkan NAMA PRODUK (bukan faktur/sales/customer/alamat/dsb),
  // supaya hasilnya sesuai ekspektasi: ketik "ns" → hanya produk yang namanya mengandung "ns".
  function matchQuickSearch(r, qLower){
    if (!qLower) return true;
    const produk = String(r.produk ?? r.Produk ?? '').toLowerCase();
    return produk.includes(qLower);
  }
  let viewCache = {};
  let buildCache = new Map();      // signature filter -> hasil agregasi R (cache agar tidak dihitung ulang saat filter yang sama dipakai lagi)
  const BUILD_CACHE_MAX = 20;      // batasi jumlah entri cache
  const LARGE_RESULT_WARN = 20000; // ambang jumlah baris hasil filter yang dianggap berat untuk browser
  let dataVersion = 0, s0KeyBuilt = '', s0Vis = [], s0FootHtml = '', s0Cols = '', s0Widths = {};
  let pendingHargaBeliChanges = new Map();
  let gudangData = null;               // {products:[{name,col}], saldoAwal:{name:stok}, rows:[{ts,tanggal,values:{name:{masuk,keluar,stok}}}]}
  let editHargaBeliMode = false;

  /* ------------- Cloud Sync (Supabase) ------------- */
  const SUPABASE_URL = 'https://twrfpovxjuubisskljjv.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_AeR-sG7aYIFrP5nIsloGfw_uJVYO3GN';
  const SYNC_ROW_ID  = 'main'; // 1 baris = 1 "database" bersama untuk semua device
  let sbClient = null, isSyncingFromCloud = false, pushTimer = null, realtimeReady = false;

  function initSupabase(){
    try {
      if (typeof supabase === 'undefined') return null;
      sbClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { realtime: { params: { eventsPerSecond: 2 } } });
    } catch(e){ console.warn('Supabase init gagal', e); sbClient = null; }
    return sbClient;
  }

  async function gatherLocalSnapshot(){
    if (!useIDB) return null;
    const tx   = await db.tx.toArray();
    const meta = await db.meta.toArray();
    return { tx, meta };
  }

  // Kirim seluruh data lokal ke cloud (dipanggil setelah setiap perubahan data).
  async function pushToCloud(){
    if (!sbClient) throw new Error('Cloud belum terhubung.');
    if (!useIDB || !db) throw new Error('Penyimpanan lokal belum siap.');
    if (isSyncingFromCloud) return {skipped:true};
    const snapshot = await gatherLocalSnapshot();
    if (!snapshot) throw new Error('Data lokal tidak dapat dibaca.');
    const payload = {
      id: SYNC_ROW_ID,
      data: snapshot,
      updated_at: new Date().toISOString()
    };
    const result = await sbClient.from('app_sync').upsert(payload, { onConflict: 'id' });
    if (result.error) {
      console.error('pushToCloud gagal:', result.error);
      throw new Error(result.error.message || 'Cloud menolak data.');
    }
    setCloudStatus('Upload berhasil ke cloud • ' + new Date().toLocaleTimeString('id-ID'));
    return result.data;
  }
  // Debounce agar tidak spam network saat banyak perubahan beruntun.
  // pushInFlight menandai proses upload yang sedang berjalan (bukan cuma menunggu debounce),
  // supaya beforeunload tahu kapan benar-benar masih ada yang belum terkirim.
  let pushInFlight = false;
  function schedulePush(){
    clearTimeout(pushTimer);
    setCloudStatus('Menyinkronkan…');
    pushTimer = setTimeout(async () => {
      pushTimer = null; // timer sudah jalan, bukan lagi "pending" — reset supaya tidak nyangkut truthy selamanya
      pushInFlight = true;
      try { await pushToCloud(); }
      catch(e){ console.error('pushToCloud gagal:', e); }
      finally { pushInFlight = false; }
    }, 1200);
  }

  // Ambil data terbaru dari cloud dan timpa data lokal (dipanggil saat pertama buka & saat ada update dari device lain).
  async function pullFromCloud(opts){
    opts = opts || {};
    if (!sbClient || !useIDB) { await restoreFromDB(); await loadGudangFromDB(); return; }
    try {
      const { data, error } = await sbClient.from('app_sync').select('data,updated_at').eq('id', SYNC_ROW_ID).maybeSingle();
      if (error) throw error;
      if (data && data.data){
        isSyncingFromCloud = true;
        try {
          const snap = data.data;
          await db.tx.clear();
          if (snap.tx && snap.tx.length) await db.tx.bulkPut(snap.tx);
          await db.meta.clear();
          if (snap.meta && snap.meta.length) await db.meta.bulkPut(snap.meta);
          setCloudStatus('Sinkron dari cloud • ' + new Date().toLocaleTimeString('id-ID'));
        } finally {
          // Selalu reset, walau db.tx.clear()/bulkPut() gagal di tengah jalan —
          // supaya sinkron ke cloud tidak macet diam-diam selamanya.
          isSyncingFromCloud = false;
        }
      } else {
        // Belum ada data di cloud: kalau device ini punya data lokal, unggah dulu sebagai data awal.
        const localCount = await db.tx.count();
        if (localCount) await pushToCloud();
      }
    } catch(e){
      console.warn('pullFromCloud gagal', e);
      setCloudStatus('Gagal terhubung ke cloud (mode lokal)');
    } finally {
      await restoreFromDB();
      await loadGudangFromDB();
      if (!opts.silent) setStatus('Data tersinkron dari cloud.');
    }
  }

  // Dengarkan perubahan real-time dari device lain yang memakai link yang sama.
  function subscribeRealtime(){
    if (!sbClient || realtimeReady) return;
    realtimeReady = true;
    sbClient.channel('app_sync_live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'app_sync', filter: 'id=eq.' + SYNC_ROW_ID }, () => {
        if (!isSyncingFromCloud) pullFromCloud({ silent: true });
      })
      .subscribe();
  }

  function setCloudStatus(msg){
    let el = document.getElementById('cloudSyncStatus');
    if (!el){
      el = document.createElement('div');
      el.id = 'cloudSyncStatus';
      el.style.cssText = 'position:fixed;right:8px;bottom:8px;font-size:11px;color:#fff;background:#1f4e78cc;padding:4px 9px;border-radius:6px;z-index:9999;pointer-events:none;';
      document.body.appendChild(el);
    }
    el.textContent = msg;
  }

  /* ------------- IndexedDB (Dexie) ------------- */
  const IDB_SUPPORTED = (() => {
    try { return typeof indexedDB !== 'undefined' && typeof Dexie !== 'undefined'; } catch(e){ return false; }
  })();
  let db = null, useIDB = false;
  async function initDB(){
    if (!IDB_SUPPORTED) return;
    try {
      db = new Dexie('rekapPenjualan_v1');
      // v1: skema awal
      db.version(1).stores({
        tx:   '++id,bulan,sales,pembayaran,_ts,produk',
        meta: '&key'
      });
      // v2: indeks komposit untuk filter bulan+sales / bulan+pembayaran (+ kdCustomer)
      db.version(2).stores({
        tx:   '++id,bulan,sales,pembayaran,_ts,produk,kdCustomer,[bulan+sales],[bulan+pembayaran],[bulan+produk]',
        meta: '&key'
      });
      await db.open();
      useIDB = true;
    } catch(e){
      console.warn('IndexedDB unavailable; falling back to in-memory mode.', e);
      db = null; useIDB = false;
    }
  }

  /* ------------- Web Worker for parsing ------------- */
  const WORKER_SRC = `
self.importScripts('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
self.onmessage = function(e){
  try {
    const buf = e.data;
    const wb = XLSX.read(buf, {type:'array', cellDates:true});
    const sn = wb.Sheets['Sheet1'] || wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(sn, {defval:''});
    const col = (r, ...keys) => { for (const k of keys) { if (r[k] !== undefined && r[k] !== '') return r[k]; } return ''; };
    const num = (v) => parseFloat(String(v == null ? '' : v).replace(/[^0-9.-]/g, '')) || 0;
    const up  = (v) => String(v ?? '').trim().toUpperCase();
    const CHUNK = 4000;
    self.postMessage({type:'start', total: raw.length});
    const products = new Set(), sales = new Set(), months = new Set();
    let kept = 0, dropped = 0;
    for (let i = 0; i < raw.length; i += CHUNK){
      const end = Math.min(i + CHUNK, raw.length);
      const chunk = raw.slice(i, end).map(x => {
        if (!x) return null;
        const faktur = String(col(x,'No. Faktur','No.Faktur','No Faktur','Faktur') || '').trim();
        const produk = up(col(x,'Produk','PRODUK'));
        const sales_ = up(col(x,'Sales','SALES'));
        const jumlah = num(col(x,'Jumlah','Qty','QTY'));
        if (faktur === 'No. Faktur' || faktur === 'No.Faktur') return null;
        if (!produk || !sales_ || !jumlah) return null;
        const tglStr = col(x,'Tanggal','Date','Tgl');
        let ts = null, bulan = '';
        if (tglStr instanceof Date) {
          ts = tglStr.getTime();
          bulan = tglStr.getFullYear() + '-' + String(tglStr.getMonth()+1).padStart(2,'0');
        } else {
          const s2 = String(tglStr == null ? '' : tglStr).trim();
          const dt = new Date(s2);
          if (!isNaN(dt.getTime())) {
            ts = dt.getTime();
            bulan = dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0');
          } else {
            const m = s2.match(/(\\d{1,2})[\\/\\-](\\d{1,2})[\\/\\-](\\d{2,4})(?:\\s+(\\d{1,2}):(\\d{2})(?::(\\d{2}))?)?/);
            if (m) {
              let y = +m[3]; if (y < 100) y += 2000;
              const dd = new Date(y, +m[2]-1, +m[1], +(m[4]||0), +(m[5]||0), +(m[6]||0));
              ts = dd.getTime();
              bulan = y + '-' + String(+m[2]).padStart(2,'0');
            }
          }
        }
        const o = {
          faktur:     faktur,
          produk:     produk,
          jumlah:     jumlah,
          satuan:     String(col(x,'Satuan','SATUAN') || '').trim(),
          hargaJual:  num(col(x,'Harga Jual','HargaJual')),
          discount:   num(col(x,'Discount','Disc','Diskon')),
          total:      num(col(x,'Total','TOTAL')),
          hargaBeli:  num(col(x,'Harga Beli','HargaBeli')),
          sales:      sales_,
          pembayaran: up(col(x,'Pembayaran','PEMBAYARAN')),
          customer:   String(col(x,'Customer','Pelanggan') || '').trim(),
          kdCustomer: String(col(x,'Kd Customer','KD Customer','Kode Customer','KodeCustomer') ?? '').trim(),
          alamat:     String(col(x,'Alamat','ALAMAT') || '').trim(),
          tanggal:    tglStr,
          _ts:        ts,
          bulan:      bulan
        };
        if (produk) products.add(produk);
        if (sales_) sales.add(sales_);
        if (bulan)  months.add(bulan);
        return o;
      }).filter(Boolean);
      self.postMessage({type:'chunk', chunk});
    }
    self.postMessage({type:'done', products:[...products], sales:[...sales], months:[...months]});
  } catch(err){
    self.postMessage({type:'error', message: err && (err.message || String(err)) });
  }
};
`;

  let _worker = null, _fallbackMode = false, _parseFileName = '';
  function getWorker(){
    if (_fallbackMode) return null;
    if (_worker) return _worker;
    try {
      const blob = new Blob([WORKER_SRC], {type:'application/javascript'});
      const url = URL.createObjectURL(blob);
      _worker = new Worker(url);
      _worker.onmessage = onWorkerMsg;
      _worker.onerror = function(err){
        console.warn('Worker error, switching to in-memory fallback', err);
        _fallbackMode = true;
      };
    } catch(e){
      console.warn('Worker init failed; in-memory fallback will be used.', e);
      _fallbackMode = true;
    }
    return _worker;
  }
  /* Gabungkan meta (products/sales/months) dari file baru dengan yang sudah tersimpan. */
  async function mergeMetaFromIncoming(incoming){
    const unionSorted = (a, b, reverse) => {
      const s = new Set([...(a||[]), ...(b||[])]);
      const arr = [...s].filter(Boolean);
      arr.sort();
      return reverse ? arr.reverse() : arr;
    };
    let products = incoming.products || [];
    let sales = incoming.sales || [];
    let months = incoming.months || [];
    if (useIDB){
      try {
        const oldP = ((await db.meta.get('products')) || {}).value || [];
        const oldS = ((await db.meta.get('sales'))    || {}).value || [];
        const oldM = ((await db.meta.get('months'))   || {}).value || [];
        products = unionSorted(oldP, products, false);
        sales    = unionSorted(oldS, sales, false);
        months   = unionSorted(oldM, months, true);
        await db.meta.put({key:'products', value:products});
        await db.meta.put({key:'sales',    value:sales});
        await db.meta.put({key:'months',   value:months});
      } catch(e){ console.warn('mergeMeta', e); }
    } else {
      const oldP = [...new Set(rows.map(x => U(x.produk)).filter(Boolean))];
      const oldS = [...new Set(rows.map(x => U(x.sales)).filter(Boolean))];
      const oldM = [...new Set(rows.map(x => x.bulan).filter(Boolean))];
      products = unionSorted(oldP, products, false);
      sales    = unionSorted(oldS, sales, false);
      months   = unionSorted(oldM, months, true);
    }
    return {products, sales, months};
  }

  /* ------------- Deteksi & konfirmasi selisih Harga Beli (data lama di HTML vs Excel baru) ------------- */
  async function getOldRowsForMonths(monthList){
    const monthSet = new Set((monthList||[]).filter(Boolean));
    if (!monthSet.size) return [];
    if (useIDB){
      try { return await db.tx.where('bulan').anyOf([...monthSet]).toArray(); }
      catch(e){ console.warn('getOldRowsForMonths', e); return []; }
    }
    return rows.filter(x => monthSet.has(x.bulan));
  }

  /* Kelompokkan baris per produk+bulan -> semua Harga Beli unik yang muncul + harga yang berlaku paling akhir (tanggal terbaru). */
  function buildHargaBeliGroups(list){
    const map = new Map();
    for (const r of (list || [])){
      const produk = U(r.produk);
      const bulan  = r.bulan;
      const hb     = N(r.hargaBeli);
      if (!produk || !bulan || !hb) continue;
      const key = produk + '|' + bulan;
      let g = map.get(key);
      if (!g){ g = {produk, bulan, prices:new Set(), latest:null}; map.set(key, g); }
      g.prices.add(hb);
      if (!g.latest || (r._ts||0) >= (g.latest._ts||0)) g.latest = {price:hb, _ts:r._ts||0};
    }
    return map;
  }

  function detectHargaBeliConflicts(oldMap, newMap){
    const conflicts = [];
    for (const [key, ng] of newMap){
      const og = oldMap.get(key);
      if (!og) continue;
      const oldPrices = [...og.prices].sort((a,b)=>a-b);
      const newPrices = [...ng.prices].sort((a,b)=>a-b);
      const same = oldPrices.length === newPrices.length && oldPrices.every((v,i)=>v===newPrices[i]);
      if (!same) conflicts.push({produk: og.produk, bulan: og.bulan, oldPrices, newPrices, htmlPrice: og.latest.price});
    }
    // Urutkan supaya rapi: per produk, lalu per bulan
    conflicts.sort((a,b) => a.produk.localeCompare(b.produk) || String(a.bulan).localeCompare(String(b.bulan)));
    return conflicts;
  }

  let _hbDiffResolver = null, _hbDiffConflicts = [];
  function renderHbDiffModal(conflicts){
    const wrap = document.getElementById('hbDiffRows');
    wrap.innerHTML = conflicts.map((c, i) => {
      const oldTxt = c.oldPrices.map(rp).join(', ');
      const newTxt = c.newPrices.map(rp).join(', ');
      return '<div class="hbdiff-row" data-idx="'+i+'">'
        + '<div class="hbdiff-produk">'+ (c.produk||'') +'</div>'
        + '<div class="hbdiff-bulan">'+ monthLabel(c.bulan) +'</div>'
        + '<div class="hbdiff-price-old">'+ oldTxt +'</div>'
        + '<div class="hbdiff-price-new">'+ newTxt +'</div>'
        + '<div class="hbdiff-choice">'
          + '<label class="active-html"><input type="radio" name="hbdc'+i+'" value="html" checked onchange="hbDiffRadioChange(this)"> Samakan HTML</label>'
          + '<label><input type="radio" name="hbdc'+i+'" value="excel" onchange="hbDiffRadioChange(this)"> Tetap Excel</label>'
        + '</div>'
        + '</div>';
    }).join('');
  }

  function hbDiffRadioChange(input){
    const row = input.closest('.hbdiff-row');
    row.querySelectorAll('.hbdiff-choice label').forEach(l => l.classList.remove('active-html','active-excel'));
    input.closest('label').classList.add(input.value === 'html' ? 'active-html' : 'active-excel');
  }

  function hbDiffSetAll(choice){
    document.querySelectorAll('#hbDiffRows .hbdiff-row').forEach(row => {
      const input = row.querySelector('input[value="'+choice+'"]');
      if (input){ input.checked = true; hbDiffRadioChange(input); }
    });
  }

  function hbDiffCancel(){
    document.getElementById('hbDiffOverlay').classList.remove('show');
    if (_hbDiffResolver){ const r = _hbDiffResolver; _hbDiffResolver = null; r(null); }
  }

  function hbDiffConfirm(){
    const decisions = [];
    document.querySelectorAll('#hbDiffRows .hbdiff-row').forEach(row => {
      const idx = +row.dataset.idx;
      const checked = row.querySelector('input:checked');
      decisions[idx] = checked ? checked.value : 'excel';
    });
    document.getElementById('hbDiffOverlay').classList.remove('show');
    if (_hbDiffResolver){ const r = _hbDiffResolver; _hbDiffResolver = null; r(decisions); }
  }

  function showHbDiffModal(conflicts){
    _hbDiffConflicts = conflicts;
    renderHbDiffModal(conflicts);
    document.getElementById('hbDiffOverlay').classList.add('show');
    return new Promise(resolve => { _hbDiffResolver = resolve; });
  }

  /* Bandingkan Harga Beli lama (sudah tersimpan / di-set manual) vs baru (dari file Excel yang baru diupload),
     untuk bulan-bulan yang akan ditimpa. Jika beda, tampilkan modal peringatan dan tunggu keputusan user.
     Return true = lanjutkan import, false = user membatalkan import.
     Jika user pilih "Samakan HTML" untuk suatu produk, SEMUA baris produk itu di file Excel yang baru diupload
     akan diubah hargaBeli-nya mengikuti harga HTML (harga yang berlaku paling akhir/terbaru). */
  async function resolveHargaBeliConflicts(incomingRows, monthList){
    try {
      const oldRows = await getOldRowsForMonths(monthList);
      if (!oldRows.length) return true;
      const oldMap = buildHargaBeliGroups(oldRows);
      const newMap = buildHargaBeliGroups(incomingRows);
      const conflicts = detectHargaBeliConflicts(oldMap, newMap);
      if (!conflicts.length) return true;
      hideBusy();
      const decisions = await showHbDiffModal(conflicts);
      if (!decisions) return false; // user membatalkan import
      // "Samakan HTML" berlaku untuk SEMUA baris produk tsb di seluruh file Excel yang baru diupload (bukan cuma bulan yang konflik)
      const produkOverride = new Map(); // PRODUK -> harga HTML
      conflicts.forEach((c, i) => {
        if (decisions[i] === 'html') produkOverride.set(c.produk, c.htmlPrice);
      });
      if (produkOverride.size){
        for (const r of incomingRows){
          const key = U(r.produk);
          if (produkOverride.has(key)) r.hargaBeli = produkOverride.get(key);
        }
      }
      showBusy('Menyimpan data...');
      return true;
    } catch(e){
      console.warn('resolveHargaBeliConflicts gagal, lanjut tanpa cek', e);
      return true; // jangan blok import kalau deteksi gagal
    }
  }

  /* Kunci tanggal (YYYY-MM-DD) dari timestamp, memakai waktu lokal agar konsisten dengan field "bulan". */
  function dayKeyOfTs(ts){
    if (ts == null || isNaN(ts)) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }
  function dayRangeOfKey(k){
    const p = String(k).split('-').map(Number);
    const start = new Date(p[0], p[1]-1, p[2], 0, 0, 0, 0).getTime();
    const end   = new Date(p[0], p[1]-1, p[2], 23, 59, 59, 999).getTime();
    return [start, end];
  }
  function dayLabel(k){
    const p = String(k).split('-').map(Number);
    if (p.length < 3 || isNaN(p[0])) return String(k);
    return String(p[2]).padStart(2,'0') + '/' + String(p[1]).padStart(2,'0') + '/' + p[0];
  }

  /* Hapus data lama hanya untuk TANGGAL yang ada di file baru, lalu sisipkan baris baru.
     Bulan yang sama tapi tanggal berbeda TIDAK ikut terhapus, sehingga upload
     tgl 11-15 tidak lagi menghapus data tgl 1-10 di bulan yang sama.
     Mengembalikan daftar kunci tanggal yang diganti. */
  async function commitIncomingTx(chunkRows, monthList){
    const list = (chunkRows || []);
    const dayKeys = [...new Set(list.map(r => dayKeyOfTs(r._ts)).filter(Boolean))].sort();
    if (useIDB){
      for (const k of dayKeys){
        const r = dayRangeOfKey(k);
        try { await db.tx.where('_ts').between(r[0], r[1], true, true).delete(); }
        catch(e){ console.warn('delete tanggal', k, e); }
      }
      if (list.length){
        try { await db.tx.bulkPut(list.map(r => { const o = Object.assign({}, r); delete o.id; return o; })); }
        catch(e){ console.warn('bulkPut incoming', e); }
      }
    } else {
      const daySet = new Set(dayKeys);
      if (daySet.size) rows = rows.filter(x => !daySet.has(dayKeyOfTs(x._ts)));
      rows = rows.concat(list);
    }
    return dayKeys;
  }

  async function fallbackSyncParse(buf){
    try {
      const wb = XLSX.read(buf, {type:'array', cellDates:true});
      const sn = wb.Sheets['Sheet1'] || wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json(sn, {defval:''});
      const col = (r, ...keys) => { for (const k of keys) { if (r[k] !== undefined && r[k] !== '') return r[k]; } return ''; };
      const num = (v) => parseFloat(String(v == null ? '' : v).replace(/[^0-9.-]/g, '')) || 0;
      const up  = (v) => String(v ?? '').trim().toUpperCase();
      const products = new Set(), sales = new Set(), months = new Set();
      const out = raw.map(x => {
        if (!x) return null;
        const faktur = String(col(x,'No. Faktur','No.Faktur','No Faktur','Faktur') || '').trim();
        const produk = up(col(x,'Produk','PRODUK'));
        const sales_ = up(col(x,'Sales','SALES'));
        const jumlah = num(col(x,'Jumlah','Qty','QTY'));
        if (faktur === 'No. Faktur' || faktur === 'No.Faktur') return null;
        if (!produk || !sales_ || !jumlah) return null;
        let ts = null, bulan = '';
        const tglStr = col(x,'Tanggal','Date','Tgl');
        if (tglStr instanceof Date) { ts = tglStr.getTime(); bulan = tglStr.getFullYear()+'-'+String(tglStr.getMonth()+1).padStart(2,'0'); }
        else {
          const s2 = String(tglStr == null ? '' : tglStr).trim();
          const dt = new Date(s2);
          if (!isNaN(dt.getTime())) { ts = dt.getTime(); bulan = dt.getFullYear()+'-'+String(dt.getMonth()+1).padStart(2,'0'); }
        }
        const o = {
          faktur, produk, jumlah,
          satuan: String(col(x,'Satuan','SATUAN') || '').trim(),
          hargaJual: num(col(x,'Harga Jual','HargaJual')),
          discount: num(col(x,'Discount','Disc','Diskon')),
          total: num(col(x,'Total','TOTAL')),
          hargaBeli: num(col(x,'Harga Beli','HargaBeli')),
          sales: sales_,
          pembayaran: up(col(x,'Pembayaran','PEMBAYARAN')),
          customer: String(col(x,'Customer','Pelanggan') || '').trim(),
          kdCustomer: String(col(x,'Kd Customer','KD Customer','Kode Customer','KodeCustomer') ?? '').trim(),
          alamat: String(col(x,'Alamat','ALAMAT') || '').trim(),
          tanggal: tglStr, _ts: ts, bulan: bulan
        };
        if (produk) products.add(produk);
        if (sales_) sales.add(sales_);
        if (bulan) months.add(bulan);
        return o;
      }).filter(Boolean);
      // Jangan hapus semua: hanya ganti bulan yang ada di file baru
      const monthList = [...months];
      try {
        const lanjut = await resolveHargaBeliConflicts(out, monthList);
        if (!lanjut){ setStatus('Import dibatalkan.'); hideBusy(); return; }
        const replacedDays = await commitIncomingTx(out, monthList);
        const merged = await mergeMetaFromIncoming({products:[...products], sales:[...sales], months:monthList});
        populateFiltersFromMeta(merged);
        await postParseDone(raw.length, replacedDays, out.length);
      } catch(err){
        console.error(err);
        setStatus('Gagal menyimpan data: ' + (err.message || err));
        hideBusy();
      }
    } catch(err){
      setStatus('Gagal membaca Excel: ' + (err.message || err));
      hideBusy();
    }
  }

  async function processFile(){
    const f = document.getElementById('file').files[0];
    if (!f) return alert('Pilih file Excel.');
    if (_inFlightWorker) return alert('Masih memproses file sebelumnya, tunggu sampai selesai.');
    _parseFileName = f.name;
    _pendingChunks = [];
    showBusy('Membaca file ' + f.name + '...');
    setStatus('Membaca file...');
    const buf = await f.arrayBuffer();
    // TIDAK clear semua data — file baru digabung; bulan yang sama diganti, bulan lain tetap.
    const w = getWorker();
    if (w){
      _inFlightWorker = true;
      try { w.postMessage(buf, [buf]); } catch(e){ _inFlightWorker = false; await fallbackSyncParse(buf); }
    } else {
      await fallbackSyncParse(buf);
    }
  }

  let _inFlightWorker = false;
  let _pendingChunks = [];
  async function onWorkerMsg(e){
    const m = e.data;
    if (m.type === 'start'){
      _pendingChunks = [];
      setStatus('Memparsing Excel di worker... (0 / ' + m.total.toLocaleString('id-ID') + ' baris)');
    } else if (m.type === 'chunk'){
      // Tahan dulu di memori; commit setelah selesai agar bisa hapus per-bulan dulu
      _pendingChunks = _pendingChunks.concat(m.chunk || []);
      setStatus('Memparsing Excel... (' + _pendingChunks.length.toLocaleString('id-ID') + ' baris)');
    } else if (m.type === 'error'){
      _pendingChunks = [];
      _inFlightWorker = false;
      setStatus('Gagal membaca Excel: ' + m.message);
      hideBusy();
    } else if (m.type === 'done'){
      const monthList = (m.months || []).filter(Boolean);
      const incoming = _pendingChunks;
      _pendingChunks = [];
      _inFlightWorker = false;
      try {
        const lanjut = await resolveHargaBeliConflicts(incoming, monthList);
        if (!lanjut){ setStatus('Import dibatalkan.'); hideBusy(); return; }
        const replacedDays = await commitIncomingTx(incoming, monthList);
        const merged = await mergeMetaFromIncoming({
          products: m.products || [],
          sales: m.sales || [],
          months: monthList
        });
        populateFiltersFromMeta(merged);
        await postParseDone(incoming.length, replacedDays, incoming.length);
      } catch(err){
        console.error(err);
        setStatus('Gagal menyimpan data: ' + (err.message || err));
        hideBusy();
      }
    }
  }

  async function postParseDone(_totalRaw, replacedDays, newCount){
    let totalRows, sortData;
    if (useIDB){
      totalRows = await db.tx.count();
      sortData = await fetchFiltered();
    } else {
      totalRows = rows.length;
      sortData = rows.slice();
    }
    sortData.sort((a,b) => (b._ts || 0) - (a._ts || 0));
    filteredRows = sortData;
    materialise();
    invalidateBuildCache();   // data dasar berubah (import baru) — cache filter lama sudah tidak valid
    build(materialisedRows);
    updateSummary();
    document.getElementById('summary').style.display = 'block';
    document.getElementById('result').style.display   = 'block';
    document.getElementById('save').disabled          = totalRows === 0;
    populatedFiltersBound = totalRows > 0;
    populateFiltersDOM().catch(()=>{});
    if (typeof buildColPicker === 'function') buildColPicker();
    show('s6', document.querySelector('.tabs button.active') || document.querySelector('.tabs button'));
    const dl = (replacedDays && replacedDays.length) ? replacedDays.slice().sort() : [];
    const blLabel = dl.length
      ? (dl.length === 1 ? dayLabel(dl[0]) : dayLabel(dl[0]) + ' s/d ' + dayLabel(dl[dl.length-1]) + ' (' + dl.length + ' hari)')
      : '';
    const extra = blLabel
      ? ' — digabung (tanggal diperbarui: ' + blLabel + '; baris baru: ' + (newCount||0).toLocaleString('id-ID') + ')'
      : '';
    setStatus('Berhasil diproses: ' + _parseFileName + ' (total tersimpan ' + totalRows.toLocaleString('id-ID') + ' baris)' + extra + (useIDB ? ' — IndexedDB' : ' — in-memori'));
    closeDd();
    if (sbClient) {
      setCloudStatus('Menyinkronkan…');
      try {
        await pushToCloud();
      } catch(e){
        console.warn('Auto-sync ke cloud gagal setelah import', e);
        setCloudStatus('Gagal sync otomatis — klik "Upload Cloud" manual supaya data tidak hilang.');
      }
    }
    hideBusy();
  }

  /* ------------- materialise internal-camel rows to UI form ------------- */
  function materialiseOne(r){
    return {
      'No. Faktur':  r['No. Faktur']  ?? r.faktur,
      'Produk':      r.Produk         ?? r.produk,
      'Jumlah':      r.Jumlah         ?? r.jumlah,
      'Satuan':      r.Satuan         ?? r.satuan,
      'Harga Jual':  r['Harga Jual']  ?? r.hargaJual,
      'Discount':    r.Discount       ?? r.discount,
      'Total':       r.Total          ?? r.total,
      'Harga Beli':  r['Harga Beli']  ?? r.hargaBeli,
      'Sales':       r.Sales          ?? r.sales,
      'Pembayaran':  r.Pembayaran     ?? r.pembayaran,
      'Customer':    r.Customer       ?? r.customer,
      'Kd Customer': r['Kd Customer'] ?? r.kdCustomer,
      'Alamat':      r.Alamat         ?? r.alamat,
      'Tanggal':     r.Tanggal        ?? r.tanggal,
      '_ts':         r._ts
    };
  }
  function materialise(){
    // Hemat memori (data setahun): jangan duplikasi seluruh baris ke bentuk UI.
    // filteredRows = sumber kebenaran; materialisasi on-demand via getUiRow().
    materialisedRows = filteredRows;
  }
  function getUiRow(i){
    const r = filteredRows[i];
    if (!r) return null;
    // sudah bentuk UI (punya key 'Produk') vs internal (punya 'produk')
    if (r.Produk !== undefined || r['No. Faktur'] !== undefined) return r;
    return materialiseOne(r);
  }
  /* ------------- async filter / sort via Dexie ------------- */
  function dateStrToStartTs(s){
    if (!s) return null;
    const [y,m,d] = s.split('-').map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m-1, d, 0, 0, 0, 0).getTime();
  }
  function dateStrToEndTs(s){
    if (!s) return null;
    const [y,m,d] = s.split('-').map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m-1, d, 23, 59, 59, 999).getTime();
  }
  function rowInDateRange(r, fromTs, toTs){
    if (fromTs == null && toTs == null) return true;
    let ts = r._ts;
    if (ts == null || isNaN(ts)) {
      const d = toDate(r.tanggal ?? r.Tanggal);
      ts = d ? d.getTime() : null;
    }
    if (ts == null || isNaN(ts)) return false;
    if (fromTs != null && ts < fromTs) return false;
    if (toTs != null && ts > toTs) return false;
    return true;
  }
  function formatFilterDateLabel(from, to){
    if (!from && !to) return '';
    const fmt = (s) => {
      const [y,m,d] = s.split('-').map(Number);
      return String(d).padStart(2,'0') + '/' + String(m).padStart(2,'0') + '/' + y;
    };
    if (from && to) return from === to ? fmt(from) : (fmt(from) + ' – ' + fmt(to));
    if (from) return 'dari ' + fmt(from);
    return 's/d ' + fmt(to);
  }

  function matchKdCustomer(rowKd, q){
    if (!q) return true;
    const a = String(rowKd ?? '').trim().toUpperCase();
    const b = String(q).trim().toUpperCase();
    if (!b) return true;
    return a === b || a.includes(b);
  }

  async function fetchFiltered(){
    const fromTs = dateStrToStartTs(filters.dateFrom);
    const toTs = dateStrToEndTs(filters.dateTo);
    const kdQ = (filters.kdCustomer || '').trim();
    const qLower = (filters.q || '').trim().toLowerCase();
    if (!useIDB){
      let out = rows;
      if (filters.month)   out = out.filter(x => x.bulan === filters.month);
      if (filters.sales)   out = out.filter(x => x.sales === filters.sales);
      if (filters.product === 'FITRI')      out = out.filter(x =>  isFitriProduct(x.produk));
      if (filters.product === 'RUPA_RUPA')  out = out.filter(x => !isFitriProduct(x.produk));
      if (filters.payment) out = out.filter(x => x.pembayaran === filters.payment);
      if (fromTs != null || toTs != null) out = out.filter(x => rowInDateRange(x, fromTs, toTs));
      if (kdQ) out = out.filter(x => matchKdCustomer(x.kdCustomer ?? x['Kd Customer'], kdQ));
      if (qLower) out = out.filter(x => matchQuickSearch(x, qLower));
      return out;
    }
    // Dexie path — pakai indeks komposit bila memungkinkan
    let coll;
    if (filters.month && filters.sales) {
      coll = db.tx.where('[bulan+sales]').equals([filters.month, filters.sales]);
    } else if (filters.month && filters.payment) {
      coll = db.tx.where('[bulan+pembayaran]').equals([filters.month, filters.payment]);
    } else if (filters.month) {
      coll = db.tx.where('bulan').equals(filters.month);
    } else if (filters.sales) {
      coll = db.tx.where('sales').equals(filters.sales);
    } else if (filters.payment) {
      coll = db.tx.where('pembayaran').equals(filters.payment);
    } else {
      coll = db.tx.toCollection();
    }
    // sisa filter via .and() (tidak menggandakan yang sudah di indeks)
    const usedCompoundSales = !!(filters.month && filters.sales);
    const usedCompoundPay = !!(filters.month && filters.payment) && !usedCompoundSales;
    coll = coll.and(r => {
      if (filters.sales && !usedCompoundSales && r.sales !== filters.sales) return false;
      if (filters.payment && !usedCompoundPay && r.pembayaran !== filters.payment) return false;
      if (filters.product === 'FITRI'     && !isFitriProduct(r.produk)) return false;
      if (filters.product === 'RUPA_RUPA' &&  isFitriProduct(r.produk)) return false;
      if (!rowInDateRange(r, fromTs, toTs)) return false;
      if (kdQ && !matchKdCustomer(r.kdCustomer, kdQ)) return false;
      if (qLower && !matchQuickSearch(r, qLower)) return false;
      return true;
    });
    const out = await coll.toArray();
    return out;
  }

  function onProductQuickChange(){
    const q = document.getElementById('filterProductQuick');
    const p = document.getElementById('filterProduct');
    if (q && p) p.value = q.value;
    applyFilters();
  }
  let _applyFiltersToken = 0;
  async function applyFilters(){
    // Guard supaya pemanggilan applyFilters() yang tumpang-tindih (mis. dipicu
    // beberapa kali berturut-turut tanpa di-await dari onchange/onclick) tidak
    // saling menimpa hasil secara tidak berurutan (race condition).
    const _myToken = ++_applyFiltersToken;
    const q = document.getElementById('filterProductQuick');
    const p = document.getElementById('filterProduct');
    // samakan kedua kontrol produk
    if (q && p) {
      if (document.activeElement === q) p.value = q.value;
      else if (document.activeElement === p) q.value = p.value;
      else if (q.value !== p.value) {
        // prefer nilai di filter menu jika beda (mis. dari restore), lalu sync quick
        q.value = p.value;
      }
    }
    filters = {
      month:       document.getElementById('filterMonth').value,
      sales:       document.getElementById('filterSales').value,
      product:     document.getElementById('filterProduct').value,
      payment:     document.getElementById('filterPayment').value,
      dateFrom:    document.getElementById('filterDateFrom')?.value || '',
      dateTo:      document.getElementById('filterDateTo')?.value || '',
      kdCustomer:  (document.getElementById('filterKdCustomer')?.value || '').trim(),
      q:           (document.getElementById('quickSearch')?.value || '').trim()
    };
    // jika dari > sampai, tukar supaya tetap valid
    if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) {
      const tmp = filters.dateFrom; filters.dateFrom = filters.dateTo; filters.dateTo = tmp;
      const a = document.getElementById('filterDateFrom');
      const b = document.getElementById('filterDateTo');
      if (a) a.value = filters.dateFrom;
      if (b) b.value = filters.dateTo;
    }
    if (useIDB) { try { await db.meta.put({key:'filters', value:filters}); } catch(e){} }
    showBusy('Memfilter…');
    const filtr = await fetchFiltered();
    if (_myToken !== _applyFiltersToken) { hideBusy(); return; } // ada pemanggilan applyFilters() lain yang lebih baru, buang hasil ini
    filtr.sort((a,b) => (b._ts||0) - (a._ts||0));
    filteredRows = filtr;
    materialise();
    buildCached(materialisedRows);
    s7DateFilter = '';
    viewCache = {};
    updateSummary();
    updateFilterUi();
    const activeBtn = document.querySelector('.tabs button.active') || document.querySelector('.tabs button');
    let tabId = 's0';
    if (activeBtn) {
      const oc = activeBtn.getAttribute('onclick') || '';
      const m = oc.match(/show\('([^']+)'/);
      if (m) tabId = m[1];
    }
    show(tabId, activeBtn);
    const parts = [
      filters.month   ? monthLabel(filters.month) : '',
      formatFilterDateLabel(filters.dateFrom, filters.dateTo),
      filters.sales   || '',
      filters.product === 'FITRI' ? 'Fitri' : filters.product === 'RUPA_RUPA' ? 'Rupa Rupa' : '',
      filters.payment || '',
      filters.kdCustomer ? ('Kd: ' + filters.kdCustomer) : '',
      filters.q ? ('Cari: ' + filters.q) : ''
    ].filter(Boolean);
    const bigWarn = filteredRows.length > LARGE_RESULT_WARN
      ? ' ⚠ Data besar — pertimbangkan mempersempit filter (bulan/sales/tanggal) agar tabel Transaksi lebih ringan.'
      : '';
    document.getElementById('filterInfo').textContent =
      (parts.length ? 'Aktif: ' + parts.join(' • ') + ' — ' : '') +
      'Menampilkan ' + filteredRows.length.toLocaleString('id-ID') + ' baris.' + bigWarn;
    hideBusy();
  }

  async function resetFilters(){
    filters = {month:'',sales:'',product:'',payment:'',dateFrom:'',dateTo:'',kdCustomer:'',q:''};
    const df = document.getElementById('filterDateFrom');
    const dt = document.getElementById('filterDateTo');
    const kd = document.getElementById('filterKdCustomer');
    const qs = document.getElementById('quickSearch');
    if (df) df.value = '';
    if (dt) dt.value = '';
    if (kd) kd.value = '';
    if (qs) qs.value = '';
    if (useIDB) { try { await db.meta.put({key:'filters', value:filters}); } catch(e){} }
    await populateFiltersDOM(); // akan mengisi bulan terkini otomatis
    await applyFilters();
  }

  /* ------------- DOM helpers (UI-only, no data access) ------------- */
  let populatedFiltersBound = false;
  function toggleDd(){ document.getElementById('menuDd').classList.toggle('open') }
  function closeDd(){ document.getElementById('menuDd').classList.remove('open') }
  function toggleMoreMenu(){ document.getElementById('toolbarMore').classList.toggle('open') }
  function closeMoreMenu(){ document.getElementById('toolbarMore').classList.remove('open') }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMoreMenu(); });
  function toggleColPicker(){ document.getElementById('colPicker').classList.toggle('open'); closeFilterPicker() }
  function closeColPicker(){ document.getElementById('colPicker').classList.remove('open') }
  function toggleFilterPicker(){ document.getElementById('filterPicker').classList.toggle('open'); closeColPicker() }
  function closeFilterPicker(){ document.getElementById('filterPicker').classList.remove('open') }
  function setStatus(s){ const el = document.getElementById('status'); if (el) el.textContent = s; }
  function showBusy(label){
    let box = document.getElementById('s0box');
    if (!box) return;
    let old = document.getElementById('__busy');
    if (!old){
      old = document.createElement('div');
      old.id = '__busy'; old.className = 'busy';
      old.innerHTML = '<div class="spin"></div>' + label;
      box.appendChild(old);
    } else { old.innerHTML = '<div class="spin"></div>' + label; }
  }
  function hideBusy(){
    const old = document.getElementById('__busy'); if (old) old.remove();
  }
  document.addEventListener('click', function(e){
    const cp = document.getElementById('colPicker');
    const fp = document.getElementById('filterPicker');
    if (cp && cp.classList.contains('open') && !cp.contains(e.target)) closeColPicker();
    if (fp && fp.classList.contains('open') && !fp.contains(e.target)) closeFilterPicker();
  });
  function buildColPicker(){
    document.getElementById('colPickerMenu').innerHTML = TX_COLS.map(c =>
      '<label><input type="checkbox" data-k="' + c.k + '" ' + (colVis[c.k]?'checked':'') + ' onchange="onColChange(this)"> ' + c.label + '</label>').join('');
  }
  function onColChange(el){
    colVis[el.dataset.k] = el.checked;
    const box = document.getElementById('s0box'); if (!box) return;
    const tabs = document.querySelectorAll('.tabs button');
    let active = document.querySelector('.tabs button.active');
    if (!active || active.textContent.trim() !== 'Transaksi'){
      tabs.forEach(x => x.classList.remove('active'));
      active = Array.from(tabs).find(b => b.textContent.trim() === 'Transaksi');
      if (active) active.classList.add('active');
    }
    document.querySelectorAll('#table .view').forEach(v => v.style.display = 'none');
    const panel = document.getElementById('panel_s0'); if (panel) panel.style.display = 'block';
    s0KeyBuilt = '';
    s0Widths = computeColWidths();
    buildPanelS0();
  }
  function toDate(v){
    if (!v) return null;
    if (v instanceof Date) return v;
    if (typeof v === 'number' && v > 40000 && v < 60000) return new Date(Date.UTC(1899,11,30) + v * 86400000);
    const s = String(v).trim(), d = new Date(s);
    if (!isNaN(d.getTime())) return d;
    const m = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (m){ let y = +m[3]; if (y < 100) y += 2000; return new Date(y,+m[2]-1,+m[1],+(m[4]||0),+(m[5]||0),+(m[6]||0)) }
    return null;
  }
  function fmtTgl(v){
    const d = toDate(v);
    if (!d) return v ? String(v) : '';
    return d.toLocaleDateString('id-ID');
  }
  function monthKey(v){
    const d = toDate(v); if (!d) return '';
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
  }
  function monthLabel(key){
    if (!key) return 'Semua bulan';
    const [y,m] = key.split('-').map(Number);
    return new Date(y, m-1, 1).toLocaleDateString('id-ID',{month:'long',year:'numeric'});
  }
  /* Pilih bulan terkini: prioritaskan bulan kalender sekarang bila ada di data, else bulan terbaru di data. */
  function pickLatestMonth(months){
    if (!months || !months.length) return '';
    const now = new Date();
    const cur = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
    if (months.includes(cur)) return cur;
    // months diasumsikan sudah di-sort terbaru dulu (reverse)
    return months[0];
  }
  function isFitriProduct(p){ return U(p).includes('FITRI'); }
  // Kunci pencocokan produk yang mengabaikan perbedaan spasi/simbol penulisan,
  // supaya "FITRI BOTOL 200 ML" dan "FITRI BOTOL 200ML" dianggap produk yang SAMA.
  function productMatchKey(p){ return U(p).replace(/[^A-Z0-9]/g, ''); }

  /* Format <select> dropdowns from worker 'done' meta (sync, immediate UX). */
  function populateFiltersFromMeta(m){
    if (!m) return;
    const months = m.months || [], sales = m.sales || [], products = m.products || [];
    document.getElementById('filterMonth').innerHTML =
      '<option value="">Semua bulan</option>' +
      months.map(x => '<option value="' + x + '">' + monthLabel(x) + '</option>').join('');
    if (!filters.month && months.length) {
      filters.month = pickLatestMonth(months);
    }
    if (filters.month && months.includes(filters.month)) {
      document.getElementById('filterMonth').value = filters.month;
    }
    document.getElementById('filterSales').innerHTML =
      '<option value="">Semua sales</option>' +
      sales.map(x => '<option value="' + x + '">' + x + '</option>').join('');
    const dm = document.getElementById('deleteMonth');
    if (dm) dm.innerHTML = '<option value="">Pilih bulan...</option>' +
      months.map(x => '<option value="' + x + '">' + monthLabel(x) + '</option>').join('');
    const bm = document.getElementById('bulkHargaMonth');
    if (bm){
      const sel = bm.value;
      bm.innerHTML = '<option value="">Pilih bulan...</option>' +
        months.map(x => '<option value="' + x + '">' + monthLabel(x) + '</option>').join('');
      bm.value = months.includes(sel) ? sel : '';
    }
    const bp = document.getElementById('bulkHargaProduct');
    if (bp){
      const sel = bp.value;
      bp.innerHTML = '<option value="">Pilih produk...</option>' +
        products.map(x => '<option value="' + x.replace(/"/g,'&quot;') + '">' + x + '</option>').join('');
      bp.value = products.includes(sel) ? sel : '';
    }
  }

  async function populateFiltersDOM(){
    let months, sales, products;
    if (useIDB){
      const m = (await db.meta.get('months'))   ?.value || [];
      const s = (await db.meta.get('sales'))    ?.value || [];
      const p = (await db.meta.get('products')) ?.value || [];
      months = m; sales = s; products = p;
    } else {
      months   = [...new Set(rows.map(x => x.bulan || monthKey(x.Tanggal || x.tanggal)).filter(Boolean))].sort().reverse();
      sales    = [...new Set(rows.map(x => U(x.sales)).filter(Boolean))].sort();
      products = [...new Set(rows.map(x => U(x.produk)).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'id'));
    }
    document.getElementById('filterMonth').innerHTML =
      '<option value="">Semua bulan</option>' + months.map(m => '<option value="'+m+'">'+monthLabel(m)+'</option>').join('');
    document.getElementById('filterSales').innerHTML =
      '<option value="">Semua sales</option>' + sales.map(s => '<option value="'+s+'">'+s+'</option>').join('');
    if (!filters.month && months.length) filters.month = pickLatestMonth(months);
    if (filters.month && !months.includes(filters.month)) filters.month = pickLatestMonth(months);
    document.getElementById('filterMonth').value   = filters.month;
    document.getElementById('filterSales').value   = filters.sales;
    document.getElementById('filterProduct').value = filters.product;
    const _fpq = document.getElementById('filterProductQuick');
    if (_fpq) _fpq.value = filters.product || '';
    document.getElementById('filterPayment').value = filters.payment;
    const df = document.getElementById('filterDateFrom');
    const dt = document.getElementById('filterDateTo');
    const kd = document.getElementById('filterKdCustomer');
    const qs = document.getElementById('quickSearch');
    if (df) df.value = filters.dateFrom || '';
    if (dt) dt.value = filters.dateTo || '';
    if (kd) kd.value = filters.kdCustomer || '';
    if (qs) qs.value = filters.q || '';
    const dm = document.getElementById('deleteMonth');
    if (dm) dm.innerHTML = '<option value="">Pilih bulan...</option>' +
      months.map(m => '<option value="'+m+'">'+monthLabel(m)+'</option>').join('');
    const bm = document.getElementById('bulkHargaMonth');
    if (bm){
      const sel = bm.value;
      bm.innerHTML = '<option value="">Pilih bulan...</option>' +
        months.map(m => '<option value="'+m+'">'+monthLabel(m)+'</option>').join('');
      bm.value = months.includes(sel) ? sel : '';
    }
    const bp = document.getElementById('bulkHargaProduct');
    if (bp){
      const sel = bp.value;
      bp.innerHTML = '<option value="">Pilih produk...</option>' +
        products.map(p => '<option value="'+p.replace(/"/g,'&quot;')+'">'+p+'</option>').join('');
      bp.value = products.includes(sel) ? sel : '';
    }
    updateFilterUi();
  }
  function updateFilterUi(){
    const n = Object.values(filters).filter(Boolean).length;
    document.getElementById('filterCount').textContent = n ? n : '';
    document.getElementById('filterBtn').classList.toggle('active', n > 0);
    const parts = [];
    if (filters.month)   parts.push(monthLabel(filters.month));
    const dl = formatFilterDateLabel(filters.dateFrom, filters.dateTo);
    if (dl) parts.push(dl);
    if (filters.sales)   parts.push(filters.sales);
    if (filters.product) parts.push(filters.product === 'FITRI' ? 'Fitri' : 'Rupa Rupa');
    if (filters.payment) parts.push(filters.payment);
    if (filters.kdCustomer) parts.push('Kd: ' + filters.kdCustomer);
    if (filters.q) parts.push('Cari: ' + filters.q);
    document.getElementById('filterInfo').textContent = parts.length ? 'Aktif: ' + parts.join(' • ') : 'Filter belum diterapkan.';
  }

  /* ------------- data-mutation operations ------------- */
  async function refreshAfterDataChange(){
    if (useIDB) await populateFiltersDOM();
    filteredRows = await fetchFiltered();
    filteredRows.sort((a,b) => (b._ts||0) - (a._ts||0));
    materialise();
    invalidateBuildCache();   // data dasar berubah (hapus bulan / edit harga beli) — cache filter lama sudah tidak valid
    build(materialisedRows);
    updateSummary();
    if (!useIDB){
      const dm = document.getElementById('deleteMonth'); if (dm) dm.innerHTML = '<option value="">Pilih bulan...</option>' +
        [...new Set(rows.map(x => monthKey(x.Tanggal || x.tanggal)).filter(Boolean))].sort().reverse().map(m => '<option value="'+m+'">'+monthLabel(m)+'</option>').join('');
    }
    const active = document.querySelector('.tabs button.active') || document.querySelector('.tabs button');
    let tabId = _activeTab || 's6';
    if (active) {
      const oc = active.getAttribute('onclick') || '';
      const m = oc.match(/show\('([^']+)'/);
      if (m) tabId = m[1];
    }
    show(tabId, active);
    const total = useIDB ? await db.tx.count() : rows.length;
    document.getElementById('save').disabled = total === 0;
    schedulePush();
  }

  async function deleteMonthData(){
    let m = document.getElementById('deleteMonth').value;
    if (!m) return alert('Pilih bulan yang akan dihapus.');
    let count;
    if (useIDB){
      count = await db.tx.where('bulan').equals(m).count();
      if (!count) return alert('Tidak ada data pada bulan tersebut.');
      if (!confirm('Hapus ' + count.toLocaleString('id-ID') + ' baris pada ' + monthLabel(m) + '?')) return;
      await db.tx.where('bulan').equals(m).delete();
      const monthsMeta = ((await db.meta.get('months')) || {}).value || [];
      await db.meta.put({key:'months', value: monthsMeta.filter(x => x !== m)});
      await refreshAfterDataChange();
      setStatus('Data bulan ' + monthLabel(m) + ' berhasil dihapus: ' + count.toLocaleString('id-ID') + ' baris.');
      closeDd();
      return;
    }
    if (!rows.length) return alert('Belum ada data.');
    count = rows.filter(x => monthKey(x.Tanggal || x.tanggal) === m).length;
    if (!count) return alert('Tidak ada data pada bulan tersebut.');
    if (!confirm('Hapus ' + count.toLocaleString('id-ID') + ' baris pada ' + monthLabel(m) + '?')) return;
    rows = rows.filter(x => monthKey(x.Tanggal || x.tanggal) !== m);
    pendingHargaBeliChanges.clear();
    if (!rows.length){
      filteredRows = []; materialisedRows = []; R = {};
      dataVersion++; viewCache = {}; s0KeyBuilt = ''; invalidateBuildCache();
      document.getElementById('summary').style.display = 'none';
      document.getElementById('result').style.display = 'none';
      document.getElementById('save').disabled = true;
    } else await refreshAfterDataChange();
    editHargaBeliMode = false;
    setStatus('Data bulan ' + monthLabel(m) + ' berhasil dihapus: ' + count.toLocaleString('id-ID') + ' baris.');
    closeDd();
  }

  function dateLabelRange(fromStr, toStr){
    const fmt = (s) => { const d = new Date(s+'T00:00:00'); return isNaN(d.getTime()) ? s : d.toLocaleDateString('id-ID',{day:'2-digit',month:'short',year:'numeric'}); };
    return fromStr === toStr ? fmt(fromStr) : (fmt(fromStr) + ' s/d ' + fmt(toStr));
  }

  async function applyBulkHargaBeliByDate(){
    const fromStr = document.getElementById('bulkHargaDateFrom').value;
    const toStr   = document.getElementById('bulkHargaDateTo').value;
    const product = document.getElementById('bulkHargaProduct').value;
    const raw = document.getElementById('bulkHargaValue').value;
    if (!fromStr || !toStr) return alert('Pilih tanggal mulai dan tanggal akhir yang akan diubah harga belinya.');
    if (!product) return alert('Pilih produk yang akan diubah harga belinya.');
    const v = Number(raw);
    if (raw === '' || !Number.isFinite(v) || v < 0) return alert('Masukkan Harga Beli baru yang valid.');

    const fromTs = new Date(fromStr + 'T00:00:00').getTime();
    const toTs   = new Date(toStr   + 'T23:59:59.999').getTime();
    if (fromTs > toTs) return alert('Tanggal mulai tidak boleh lebih besar dari tanggal akhir.');
    const label = dateLabelRange(fromStr, toStr);

    if (useIDB){
      const matches = await db.tx.where('_ts').between(fromTs, toTs, true, true).and(r => U(r.produk) === U(product)).toArray();
      if (!matches.length) return alert('Tidak ada transaksi produk "' + product + '" pada ' + label + '.');
      const oldPrices = [...new Set(matches.map(r => N(r.hargaBeli)))];
      const oldText = oldPrices.length === 1 ? rp(oldPrices[0]) : oldPrices.map(rp).join(' / ');
      if (!confirm('Ubah Harga Beli "' + product + '" pada ' + label + '?\n\nJumlah: ' + matches.length.toLocaleString('id-ID') + '\nSebelumnya: ' + oldText + '\nBaru: ' + rp(v))) return;
      await db.tx.where('_ts').between(fromTs, toTs, true, true).and(r => U(r.produk) === U(product)).modify({hargaBeli: v});
      await refreshAfterDataChange();
      pendingHargaBeliChanges.clear();
      editHargaBeliMode = false;
      document.getElementById('bulkHargaValue').value = '';
      setStatus('Harga Beli "' + product + '" pada ' + label + ' diubah menjadi ' + rp(v) + ' untuk ' + matches.length.toLocaleString('id-ID') + ' transaksi.');
      closeDd();
      return;
    }
    // In-memory fallback (original path preserved)
    if (!rows.length) return alert('Belum ada data.');
    const idx = [];
    rows.forEach((x,i) => { const t = x._ts; if (t != null && t >= fromTs && t <= toTs && U(x.produk) === U(product)) idx.push(i) });
    if (!idx.length) return alert('Tidak ada transaksi produk "' + product + '" pada ' + label + '.');
    const oldPrices = [...new Set(idx.map(i => N(rows[i].hargaBeli)))];
    const oldText = oldPrices.length === 1 ? rp(oldPrices[0]) : oldPrices.map(rp).join(' / ');
    if (!confirm('Ubah Harga Beli "' + product + '" pada ' + label + '?\n\nJumlah: ' + idx.length.toLocaleString('id-ID') + '\nSebelumnya: ' + oldText + '\nBaru: ' + rp(v))) return;
    idx.forEach(i => { rows[i].hargaBeli = v; });
    pendingHargaBeliChanges.clear(); editHargaBeliMode = false;
    await refreshAfterDataChange();
    document.getElementById('bulkHargaValue').value = '';
    setStatus('Harga Beli "' + product + '" pada ' + label + ' diubah menjadi ' + rp(v) + ' untuk ' + idx.length.toLocaleString('id-ID') + ' transaksi.');
    closeDd();
  }


  /* ------------- aggregates + per-tab rerender ------------- */
  function scheduleIdle(fn){
    if (typeof requestIdleCallback === 'function') {
      return requestIdleCallback(fn, { timeout: 400 });
    }
    return setTimeout(fn, 0);
  }

  function build(data){
    dataVersion++;
    // data boleh internal (produk/jumlah) atau UI (Produk/Jumlah)
    const g = (x, ui, camel) => (x[ui] !== undefined && x[ui] !== null) ? x[ui] : x[camel];
    s0Widths = computeColWidths(data);
    // Agregat per produk dalam 1 pass (tanpa menyimpan array baris per produk → hemat memori)
    const byProd = new Map(); // produk -> stats
    let qty = 0, sales = 0, hpp = 0, profit = 0, cs = 0, ts = 0, cp = 0, tp = 0;
    let fitriQty = 0, fitriSales = 0, fitriProfit = 0, rupaQty = 0, rupaSales = 0, rupaProfit = 0;
    let totalProfitFitriRupa = 0;
    const salesQty = {}; SO.forEach(s => salesQty[s] = 0);
    // Rekap per Sales dipisah berdasarkan kelompok produk:
    // MINYAK FITRI = produk yang terdeteksi FITRI, RUPA RUPA = selain FITRI.
    // Masing-masing kelompok mempunyai hitungan faktur sendiri (1 No. Faktur = 1 faktur).
    const salesAggFitri = {}; // sales -> {q,v,h,fk}
    const salesAggRupa  = {}; // sales -> {q,v,h,fk}
    SO.forEach(s => {
      salesAggFitri[s] = { q:0, v:0, h:0, fk:new Set() };
      salesAggRupa[s]  = { q:0, v:0, h:0, fk:new Set() };
    });
    const fakturSet = new Set();
    data.forEach(x => {
      const produk = String(g(x,'Produk','produk') ?? '').trim();
      const j = N(g(x,'Jumlah','jumlah'));
      const t = N(g(x,'Total','total'));
      const hb = N(g(x,'Harga Beli','hargaBeli'));
      const hj = N(g(x,'Harga Jual','hargaJual'));
      const pay = U(g(x,'Pembayaran','pembayaran'));
      const salesName = normSales(g(x,'Sales','sales'));
      const sat = String(g(x,'Satuan','satuan') ?? '').trim();
      const nf = String(g(x,'No. Faktur','faktur') ?? '').trim();
      const hLine = j * hb;
      const rp0 = t - hLine;
      qty += j; sales += t; hpp += hLine; profit += rp0;
      if (isFitriProduct(produk)) { fitriQty += j; fitriSales += t; fitriProfit += rp0; }
      else { rupaQty += j; rupaSales += t; rupaProfit += rp0; }
      totalProfitFitriRupa = fitriProfit + rupaProfit;
      if (pay === 'CASH'){ cs += t; cp += rp0 }
      if (pay === 'TEMPO'){ ts += t; tp += rp0 }
      if (SO.includes(salesName)) salesQty[salesName] = (salesQty[salesName] || 0) + j;
      if (nf) fakturSet.add(nf);

      let st = byProd.get(produk);
      if (!st) {
        st = { qq:0, v:0, h:0, sat:'', bmin:Infinity, bmax:-Infinity, jmin:Infinity, jmax:-Infinity, qBySales:{}, jc:0, jt:0, pc:0, pt:0, hbLog:[] };
        byProd.set(produk, st);
      }
      st.qq += j; st.v += t; st.h += hLine;
      if (sat && !st.sat) st.sat = sat;
      if (!isNaN(hb)) { if (hb < st.bmin) st.bmin = hb; if (hb > st.bmax) st.bmax = hb; st.hbLog.push({ts: x._ts || 0, hb}); }
      if (!isNaN(hj)) { if (hj < st.jmin) st.jmin = hj; if (hj > st.jmax) st.jmax = hj; }
      if (SO.includes(salesName)) st.qBySales[salesName] = (st.qBySales[salesName] || 0) + j;
      if (pay === 'CASH'){ st.jc += t; st.pc += rp0 }
      if (pay === 'TEMPO'){ st.jt += t; st.pt += rp0 }

      if (SO.includes(salesName)) {
        const bucket = isFitriProduct(produk) ? salesAggFitri[salesName] : salesAggRupa[salesName];
        bucket.q += j;
        bucket.v += t;
        bucket.h += hLine;
        if (nf) bucket.fk.add(nf);
      }
    });
    const faktur = fakturSet.size, SO2 = SO.filter(s => salesQty[s] > 0);
    const s1 = [], s2 = [], s3 = [], s5 = [], s9 = [];
    byProd.forEach((st, p) => {
      if (st.bmin === Infinity) { st.bmin = 0; st.bmax = 0; }
      if (st.jmin === Infinity) { st.jmin = 0; st.jmax = 0; }
      const pr = st.v - st.h;
      s1.push([p, ...SO2.map(s => st.qBySales[s] || 0), st.qq, st.sat, range(st.bmin,st.bmax), range(st.jmin,st.jmax), st.h, st.v, pr]);
      s2.push([p, st.jc, st.jt, st.pt, st.pc, st.jc+st.jt, st.pc+st.pt]);
      s3.push([p, st.qq, st.v, st.h, range(st.jmin,st.jmax), range(st.bmin,st.bmax), pr]);
      s5.push([p, st.qq, st.sat, st.v, st.h, pr, st.v ? (pr/st.v*100) : 0]);
      let hbChange = null;
      if (st.bmin !== st.bmax && st.hbLog.length){
        const log = st.hbLog.slice().sort((a,b) => a.ts - b.ts);
        const base = log[0].hb;
        const changed = log.find(e => e.hb !== base);
        if (changed) hbChange = { ts: changed.ts, dir: changed.hb > base ? 'naik' : 'turun' };
      }
      s9.push([p, st.sat, st.bmin, st.bmax, st.jmin, st.jmax, hbChange]);
    });
    s9.sort((a,b) => String(a[0]).localeCompare(String(b[0]), 'id'));
    const qtyIdx = 1 + SO2.length;
    s1.sort((a,b) => b[qtyIdx] - a[qtyIdx]);
    s2.sort((a,b) => b[5] - a[5]);
    s3.sort((a,b) => b[1] - a[1]);
    s5.sort((a,b) => b[6] - a[6]);
    const s4fitri = [], s4rupa = [];
    SO.forEach(s => {
      const af = salesAggFitri[s];
      const ar = salesAggRupa[s];
      // Selalu tampilkan 5 sales agar struktur rekap konsisten seperti tabel Excel.
      s4fitri.push([s, af.fk.size, af.q, af.v, af.h, af.v - af.h]);
      s4rupa.push([s, ar.fk.size, ar.q, ar.v, ar.h, ar.v - ar.h]);
    });
    s4fitri.sort((a,b) => SO.indexOf(a[0]) - SO.indexOf(b[0]));
    s4rupa.sort((a,b) => SO.indexOf(a[0]) - SO.indexOf(b[0]));
    R = { s1, s2, s3, s4fitri, s4rupa, s5, s9, qty, sales, hpp, profit, cs, ts, cp, tp, SO2, faktur, fitriQty, fitriSales, fitriProfit, rupaQty, rupaSales, rupaProfit, totalProfitFitriRupa };
    // reset halaman rekap saat data berubah
    rekapPage = { s1:0, s2:0, s3:0, s5:0, s6:0, s8:0, s9:0 };
  }

  // Tanda tangan kombinasi filter yang sedang aktif, dipakai sebagai key cache hasil build().
  function filterSignature(){
    return JSON.stringify(filters);
  }

  // Bungkus build() dengan cache: jika filter yang sama pernah dihitung dan data dasar
  // belum berubah sejak itu (cache dibersihkan tiap ada mutasi data), pakai hasil lama
  // supaya tidak perlu melakukan agregasi ulang saat pindah-pindah filter/tab.
  function buildCached(data){
    const sig = filterSignature();
    const cached = buildCache.get(sig);
    if (cached){
      R = cached;
      dataVersion++;               // tetap anggap versi tampilan baru agar tab lain re-render
      rekapPage = { s1:0, s2:0, s3:0, s5:0, s6:0, s8:0, s9:0 };
      return;
    }
    build(data);
    buildCache.set(sig, R);
    if (buildCache.size > BUILD_CACHE_MAX){
      buildCache.delete(buildCache.keys().next().value); // buang entri paling lama
    }
  }

  // Panggil ini setiap kali DATA DASAR berubah (import, hapus bulan, edit harga beli, dst).
  // Cache lama sudah tidak valid karena angka agregasinya bisa berbeda meski filter sama.
  function invalidateBuildCache(){
    buildCache.clear();
  }

  function updateSummary(){
    document.getElementById('f').textContent  = (R.faktur||0).toLocaleString('id-ID');
    document.getElementById('s').textContent  = rp(R.sales || 0);
    const fq = document.getElementById('fitriQty');
    const fn = document.getElementById('fitriNom');
    const rq = document.getElementById('rupaQty');
    const rn = document.getElementById('rupaNom');
    if (fq) fq.textContent = 'Qty ' + (R.fitriQty||0).toLocaleString('id-ID');
    if (fn) fn.textContent = rp(R.fitriSales || 0);
    if (rq) rq.textContent = 'Qty ' + (R.rupaQty||0).toLocaleString('id-ID');
    if (rn) rn.textContent = rp(R.rupaSales || 0);
    const fpr = document.getElementById('fitriProfit');
    const rpr = document.getElementById('rupaProfit');
    if (fpr) fpr.textContent = rp(R.fitriProfit != null ? R.fitriProfit : 0);
    if (rpr) rpr.textContent = rp(R.rupaProfit != null ? R.rupaProfit : 0);
    const tpr = document.getElementById('totalProfit');
    if (tpr) {
      const f = R.fitriProfit != null ? R.fitriProfit : 0;
      const r = R.rupaProfit  != null ? R.rupaProfit  : 0;
      // Hitung dari dua sumber profit agar konsisten walau cache/R hanya membawa sebagian
      tpr.textContent = rp(R.totalProfitFitriRupa != null ? R.totalProfitFitriRupa : (f + r));
    }
    if (document.getElementById('page-cek')) {
      renderCekFitri();
      if (document.getElementById('cekPanelRupa')) renderCekRupa();
    }
  }

  function tbl(head, data, total){
    return '<div class="tablebox"><table><thead><tr>' + head.map(x => '<th>'+x+'</th>').join('') + '</tr></thead><tbody>' +
      data.map(r => '<tr>' + r.map(x => '<td class="' + (typeof x === 'number' ? 'num' : '') + '">' + x + '</td>').join('') + '</tr>').join('') +
      '</tbody><tfoot><tr>' + total.map(x => '<td class="num">' + x + '</td>').join('') + '</tr></tfoot></table></div>';
  }
  /* ------------- tombol laporan Excel per sub-tab ------------- */
  function reportBar(tab, label){
    return '';
  }

  function reportMetaRows(title){
    // Blok metadata (LAPORAN/BULAN/SALES/dst) dihilangkan agar sheet Excel
    // langsung dimulai dari baris header tabel di A1 (tanpa baris kosong di atas).
    return [];
  }

  function styleReportSheet(ws, data, freezeRow){
    const fr = (freezeRow===undefined || freezeRow===null) ? 1 : freezeRow;
    const cols = [];
    const maxCols = data.reduce((m,r)=>Math.max(m, r.length), 0);
    for (let c=0;c<maxCols;c++){
      let max=10;
      for (let r=0;r<data.length;r++){
        const v=data[r][c];
        if (v===undefined || v===null) continue;
        max=Math.max(max, String(v).length + 2);
      }
      cols.push({wch:Math.min(42, Math.max(10, max))});
    }
    ws['!cols']=cols;
    ws['!freeze']={xSplit:0,ySplit:fr+1};
    if (maxCols && data.length>fr) ws['!autofilter']={ref:XLSX.utils.encode_range({s:{r:fr,c:0},e:{r:data.length-1,c:maxCols-1}})};
  }

  function addReportSheet(wb, sheetName, title, head, rows, total){
    const meta=reportMetaRows(title);
    const data=[...meta, head, ...(rows||[])];
    if (total) data.push(total);
    const ws=XLSX.utils.aoa_to_sheet(data);
    const headerRow=meta.length;
    const range=XLSX.utils.decode_range(ws['!ref']);
    for(let c=range.s.c;c<=range.e.c;c++){
      const cell=ws[XLSX.utils.encode_cell({r:headerRow,c})];
      if(cell) cell.s={font:{bold:true},alignment:{horizontal:'center',vertical:'center'}};
    }
    styleReportSheet(ws,data,headerRow);
    XLSX.utils.book_append_sheet(wb,ws,sheetName.slice(0,31));
  }

  function saveExcelTab(tab){
    if (!R || !R.s1) return alert('Belum ada data untuk disimpan.');
    const wb=XLSX.utils.book_new();
    const r=R, SO2=r.SO2||SO, n=SO2.length;
    if(tab==='s0'){
      const head=['NO','TANGGAL','NO. FAKTUR','PRODUK','QTY','SATUAN','HARGA JUAL','HARGA BELI','DISC','TOTAL','HPP','PROFIT','SALES','PEMBAYARAN','CUSTOMER','KODE CUSTOMER','ALAMAT'];
      const rows=filteredRows.map((_,i)=>{const x=getUiRow(i); const pr=N(x.Total)-N(x.Jumlah)*N(x['Harga Beli']); return [i+1,fmtTgl(x.Tanggal),x['No. Faktur'],x.Produk,x.Jumlah,x.Satuan||'',N(x['Harga Jual']),N(x['Harga Beli']),N(x.Discount),N(x.Total),N(x.Jumlah)*N(x['Harga Beli']),pr,x.Sales,x.Pembayaran,x.Customer||'',x['Kd Customer']||'',x.Alamat||''];});
      addReportSheet(wb,'Transaksi','Transaksi Penjualan',head,rows,['TOTAL','','','',r.qty,'','','','','',r.hpp,r.profit,'','','','','']);
    } else if(tab==='s1'){
      const head=['PRODUK',...SO2,'TOTAL QTY','SATUAN','HARGA BELI','HARGA JUAL','BELI X QTY','JUAL X QTY','PROFIT'];
      const rows=(r.s1||[]).map(x=>{const row=[x[0]];for(let i=1;i<=n;i++)row.push(x[i]);row.push(x[n+1],x[n+2],x[n+3],x[n+4],x[n+5],x[n+6],x[n+7]);return row;});
      addReportSheet(wb,'Produk','Rekap per Produk',head,rows,['TOTAL',...SO2.map((s,i)=>(r.s1||[]).reduce((a,x)=>a+(x[1+i]||0),0)),r.qty,'','','',r.hpp,r.sales,r.profit]);
    } else if(tab==='s2'){
      addReportSheet(wb,'Profit Pembayaran','Profit Per Pembayaran',['PRODUK','NOMINAL PENJUALAN CASH','NOMINAL PENJUALAN TEMPO','PROFIT TEMPO','PROFIT CASH','TOTAL NOMINAL PENJUALAN','TOTAL PROFIT'],r.s2||[],['TOTAL',r.cs,r.ts,r.tp,r.cp,r.sales,r.profit]);
    } else if(tab==='s3'){
      addReportSheet(wb,'Profit Produk','Profit Penjualan per Produk',['NO','PRODUK','QTY','TOTAL PENJUALAN','TOTAL HPP','HARGA JUAL','HARGA BELI','PROFIT'],(r.s3||[]).map((x,i)=>[i+1,...x]),['TOTAL','',r.qty,r.sales,r.hpp,'','',r.profit]);
    } else if(tab==='s4'){
      const head=['SALES','JUMLAH FAKTUR','TOTAL QTY','TOTAL PENJUALAN','TOTAL HPP','TOTAL PROFIT'];
      const rowsFitri=(r.s4fitri||[]).map(x=>[x[0],x[1],x[2],x[3],x[4],x[5]]);
      const rowsRupa=(r.s4rupa||[]).map(x=>[x[0],x[1],x[2],x[3],x[4],x[5]]);
      const tot=a=>['TOTAL',a.reduce((q,x)=>q+x[1],0),a.reduce((q,x)=>q+x[2],0),a.reduce((q,x)=>q+x[3],0),a.reduce((q,x)=>q+x[4],0),a.reduce((q,x)=>q+x[5],0)];
      addReportSheet(wb,'MINYAK FITRI','Rekap per Sales - MINYAK FITRI',head,rowsFitri,tot(r.s4fitri||[]));
      addReportSheet(wb,'RUPA RUPA','Rekap per Sales - RUPA RUPA',head,rowsRupa,tot(r.s4rupa||[]));
    } else if(tab==='s5'){
      const avgM=r.sales?(r.profit/r.sales*100):0;
      addReportSheet(wb,'Margin Produk','Margin % per Produk',['NO','PRODUK','QTY','SATUAN','TOTAL PENJUALAN','TOTAL HPP','PROFIT','MARGIN %'],(r.s5||[]).map((x,i)=>[i+1,x[0],x[1],x[2],x[3],x[4],x[5],Math.round(x[6]*100)/100]),['TOTAL','',r.qty,'',r.sales,r.hpp,r.profit,Math.round(avgM*100)/100]);
    } else if(tab==='s6'){
      const fRows=buildFakturRows();
      const head=['NO','TANGGAL','NO. FAKTUR','SALES','PRODUK','QTY','SATUAN','HARGA JUAL','DISC','TOTAL','NOMINAL FAKTUR','PROFIT PER FAKTUR','PEMBAYARAN','CUSTOMER'];
      const rows=fRows.map((row,i)=>{const x=row.x;return [i+1,fmtTgl(x.Tanggal),row.faktur,x.Sales||row.sales||'',x.Produk||'',N(x.Jumlah),x.Satuan||'',N(x['Harga Jual']),N(x.Discount),N(x.Total),row.isFirst?row.nominal:'',row.isFirst?row.profit:'',x.Pembayaran||row.bayar||'',x.Customer||row.customer||''];});
      addReportSheet(wb,'Faktur','Rekap per Faktur',head,rows,['TOTAL','','','','',r.qty,'','','',r.sales,r.sales,r.profit,'','']);
    } else if(tab==='s8'){
      const groups=buildFakturGroups();
      const head=['NO','TANGGAL','NO. FAKTUR','SALES','CUSTOMER','PEMBAYARAN','NOMINAL FAKTUR','PROFIT FAKTUR','MARGIN %'];
      const rows=groups.map((g,i)=>[i+1,fmtTgl(g.tgl),g.faktur,g.sales||'',g.customer||'',g.bayar||'',g.nominal,g.profit,g.nominal?Math.round(g.profit/g.nominal*10000)/100:0]);
      const totNominal=groups.reduce((a,g)=>a+g.nominal,0);
      const totProfit=groups.reduce((a,g)=>a+g.profit,0);
      const avgM=totNominal?(totProfit/totNominal*100):0;
      addReportSheet(wb,'Profit Faktur','Profit per Faktur',head,rows,['TOTAL','','','','','',totNominal,totProfit,Math.round(avgM*100)/100]);
    } else if(tab==='s7'){
      const pivot=buildS7Pivot(s7DateFilter);
      const head=['TGL','PRODUK',...SO_S7.map(s=>s==='PARIMIN'?'PRTIMIN':s),'TOTAL QTY'];
      const rows=pivot.rows.map(r=>[
        r.isFirst?r.dateLabel:'',
        r.produk,
        ...SO_S7.map(s=>r.q[s]||0),
        r.total
      ]);
      const total=['TOTAL','',...SO_S7.map(s=>pivot.grand[s]||0),pivot.grandTotal||0];
      addReportSheet(wb,'Sales per Produk','Qty Penjualan Per Sales Per Tgl',head,rows,total);
    } else if(tab==='s9'){
      const head=['PRODUK','SATUAN','HARGA BELI TERENDAH','HARGA BELI TERTINGGI','HARGA JUAL TERENDAH','HARGA JUAL TERTINGGI','KET'];
      const rows=(r.s9||[]).map(x=>[x[0],x[1]||'',x[2],x[3],x[4],x[5], x[6] ? ((x[6].dir==='naik'?'Naik':'Turun')+' sejak '+fmtTgl(new Date(x[6].ts))) : '']);
      addReportSheet(wb,'Data Harga','Data Harga',head,rows,['','','','','','','']);
    } else if(tab==='s10'){
      const byMonth = new Map();
      for(let i=0;i<filteredRows.length;i++){
        const x=getUiRow(i); if(!x) continue;
        const mk=monthKey(x.Tanggal||x.tanggal); if(!mk) continue;
        let m=byMonth.get(mk);
        if(!m){ m={fitri:{q:0,n:0,p:0},rupa:{q:0,n:0,p:0}}; byMonth.set(mk,m); }
        const j=N(x.Jumlah), t=N(x.Total), pr=t-j*N(x['Harga Beli']);
        const b=isFitriProduct(x.Produk)?m.fitri:m.rupa;
        b.q+=j; b.n+=t; b.p+=pr;
      }
      const months=[...byMonth.keys()].sort();
      const head=['Bulan','Qty Fitri','Nominal Fitri','Profit Fitri','Qty Rupa Rupa','Nominal Rupa Rupa','Profit Rupa Rupa','Total Nominal Penjualan','Total Profit'];
      const rows=months.map(mk=>{
        const m=byMonth.get(mk); const f=m.fitri, r=m.rupa;
        return [monthLabelShort(mk), f.q, f.n, f.p, r.q, r.n, r.p, f.n+r.n, f.p+r.p];
      });
      const tot=rows.reduce((a,x)=>[a[0]+x[1],a[1]+x[2],a[2]+x[3],a[3]+x[4],a[4]+x[5],a[5]+x[6],a[6]+x[7],a[7]+x[8]],[0,0,0,0,0,0,0,0]);
      addReportSheet(wb,'Data Bulanan','Rekap Data Bulanan',head,rows,['TOTAL',...tot]);
    }
    const name='Laporan_'+({s0:'Transaksi',s1:'Produk',s2:'Profit_Pembayaran',s3:'Profit_Produk',s4:'Rekap_Sales',s5:'Margin_Produk',s6:'Faktur',s7:'Sales_per_Produk',s8:'Profit_Faktur',s9:'Data_Harga',s10:'Data_Bulanan'}[tab]||'Penjualan')+'.xlsx';
    XLSX.writeFile(wb,name);
  }

  /* ------------- virtualised Transaksi panel ------------- */
  let _activeTab = 's6';
  function show(t, b){
    _activeTab = t;
    document.querySelectorAll('.tabs button').forEach(x => x.classList.remove('active'));
    if (b) b.classList.add('active');
    document.getElementById('colPicker').style.display = (t === 's0') ? 'block' : 'none';
    const s7q = document.getElementById('s7DateQuick');
    if (s7q) {
      s7q.style.display = (t === 's7') ? 'flex' : 'none';
      if (t === 's7') {
        const sel = document.getElementById('s7DateFilter');
        if (sel) {
          const cur = s7DateFilter || '';
          sel.innerHTML = s7DateOptionsHtml();
          sel.value = cur;
        }
      }
    }
    const fmt = document.getElementById('fakturModeToggle');
    if (fmt) {
      const showMode = t === 's6';
      fmt.style.display = showMode ? 'block' : 'none';
      const div = document.getElementById('moreModeDivider');
      if (div) div.style.display = showMode ? 'block' : 'none';
      if (showMode) {
        const tb = document.getElementById('fmTableBtn');
        const cb = document.getElementById('fmCardBtn');
        if (tb) tb.classList.toggle('active', fakturViewMode === 'table');
        if (cb) cb.classList.toggle('active', fakturViewMode === 'card');
      }
    }
    closeColPicker();
    document.querySelectorAll('#table .view').forEach(v => v.style.display = 'none');
    const panel = document.getElementById('panel_' + t);
    if (panel) panel.style.display = 'block';
    if (t === 's0'){
      const k = s0Key();
      if (s0KeyBuilt !== k){ buildPanelS0(); s0KeyBuilt = k; }
    } else if (!viewCache[t] || viewCache[t].ver !== dataVersion){
      // render tab di idle agar UI (klik tab) terasa responsif
      if (panel) panel.innerHTML = '<div style="padding:28px;text-align:center;color:#64748b;font-size:13px">Menyiapkan rekap…</div>';
      const ver = dataVersion;
      const tab = t;
      scheduleIdle(function(){
        if (dataVersion !== ver) return; // data sudah berubah lagi
        const html = renderTab(tab);
        viewCache[tab] = { ver: ver, html: html };
        const p = document.getElementById('panel_' + tab);
        if (p && p.style.display !== 'none') p.innerHTML = html;
      });
    } else if (panel && viewCache[t]) {
      panel.innerHTML = viewCache[t].html;
    }
  }
  function s0Key(){ return dataVersion + '|' + TX_COLS.filter(c => colVis[c.k]).map(c => c.k).join(','); }

  function computeColWidths(rowsArg){
    const base = {no:40,tgl:110,faktur:90,produk:120,qty:50,satuan:60,hjual:100,hargabeli:100,disc:90,total:100,hpp:100,profit:100,sales:70,bayar:100,customer:110,kdcustomer:110,alamat:150};
    const w = Object.assign({}, base);
    const upd = (k,v) => { const q = Math.round(v); if (q > w[k]) w[k] = q; };
    const numW = v => { const a = Math.abs(N(v)); if (!a) return 70; const digs = Math.ceil(Math.log10(a + 1)); return Math.min(190, (digs + Math.ceil(digs/3) + 3) * 8 + 22); };
    const data = rowsArg || materialisedRows;
    // Sampling: max ~400 baris (ujung + tengah) agar render awal tetap cepat
    const n = data.length;
    const MAX_SAMPLE = 400;
    let indices;
    if (n <= MAX_SAMPLE) {
      indices = null; // scan semua
    } else {
      indices = [];
      const head = Math.floor(MAX_SAMPLE * 0.4);
      const tail = Math.floor(MAX_SAMPLE * 0.3);
      const mid = MAX_SAMPLE - head - tail;
      for (let i = 0; i < head; i++) indices.push(i);
      const midStart = Math.floor(n / 2 - mid / 2);
      for (let i = 0; i < mid; i++) indices.push(midStart + i);
      for (let i = n - tail; i < n; i++) indices.push(i);
    }
    const visit = (x) => {
      if (!x) return;
      const produk = x.Produk ?? x.produk;
      const customer = x.Customer ?? x.customer;
      const alamat = x.Alamat ?? x.alamat;
      const kd = x['Kd Customer'] ?? x.kdCustomer;
      const faktur = x['No. Faktur'] ?? x.faktur;
      const satuan = x.Satuan ?? x.satuan;
      const tanggal = x.Tanggal ?? x.tanggal;
      const sales = x.Sales ?? x.sales;
      const bayar = x.Pembayaran ?? x.pembayaran;
      const jumlah = x.Jumlah ?? x.jumlah;
      const hj = x['Harga Jual'] ?? x.hargaJual;
      const hb = x['Harga Beli'] ?? x.hargaBeli;
      const disc = x.Discount ?? x.discount;
      const total = x.Total ?? x.total;
      if (produk) upd('produk', String(produk).length * 7.2 + 18);
      if (customer) upd('customer', String(customer).length * 7.2 + 18);
      if (alamat) upd('alamat', String(alamat).length * 7 + 18);
      if (kd) upd('kdcustomer', String(kd).length * 7.5 + 18);
      if (faktur) upd('faktur', String(faktur).length * 7.5 + 18);
      if (satuan) upd('satuan', String(satuan).length * 7 + 18);
      if (tanggal) upd('tgl', fmtTgl(tanggal).length * 7 + 26);
      if (sales) upd('sales', String(sales).length * 7.2 + 18);
      if (bayar) upd('bayar', String(bayar).length * 7.2 + 18);
      upd('qty', numW(N(jumlah)));
      upd('hjual', numW(N(hj)));
      upd('hargabeli', numW(N(hb)));
      upd('disc', numW(N(disc)));
      upd('total', numW(N(total)));
      upd('hpp', numW(N(jumlah) * N(hb)));
      upd('profit', numW(N(total) - N(jumlah) * N(hb)));
    };
    if (!indices) {
      for (let i = 0; i < n; i++) visit(data[i]);
    } else {
      for (let i = 0; i < indices.length; i++) visit(data[indices[i]]);
    }
    TX_COLS.forEach(c => { w[c.k] = Math.max(40, Math.min(340, Math.round(w[c.k]))); });
    return w;
  }

  function buildPanelS0(){
    const box = document.getElementById('s0box'); if (!box) return;
    const act = document.getElementById('s0actions'); if (act) act.innerHTML = '';
    s0Vis = TX_COLS.filter(c => colVis[c.k]);
    const head = s0Vis.map(c => '<th>' + c.label + '</th>').join('');
    const totMap = {no:'TOTAL',tgl:'',faktur:'',produk:'',qty:R.qty,satuan:'',hjual:'',hargabeli:'',disc:'',
      total:rp(R.sales),hpp:rp(R.hpp),profit:rp(R.profit),sales:'',bayar:'',customer:'',kdcustomer:'',alamat:''};
    s0FootHtml = s0Vis.map(c => '<td class="num">' + totMap[c.k] + '</td>').join('');
    s0Cols = s0Vis.map(c => '<col style="width:' + (s0Widths[c.k] || 90) + 'px">').join('');
    box.innerHTML = '<table style="table-layout:fixed"><colgroup>' + s0Cols + '</colgroup><thead><tr>' + head + '</tr></thead><tbody id="s0tbody"></tbody></table>';
    const ft = document.getElementById('s0foot');
    if (ft) ft.innerHTML = '<colgroup>' + s0Cols + '</colgroup><tfoot><tr>' + s0FootHtml + '</tr></tfoot>';
    if (!box._vb){
      box._vb = true;
      box.onscroll = function(){
        const fw = document.getElementById('s0footwrap'); if (fw) fw.scrollLeft = box.scrollLeft;
        if (box._raf) return; box._raf = true;
        requestAnimationFrame(function(){ box._raf = false; s0Render(); });
      };
    }
    box.scrollTop = 0;
    s0Render();
  }
  function s0Render(){
    const box = document.getElementById('s0box'), tb = document.getElementById('s0tbody');
    if (!box || !tb) return;
    const n = filteredRows.length, C = s0Vis.length;
    if (!n){ tb.innerHTML = ''; return; }
    const vh = box.clientHeight || 600;
    const vis = Math.max(1, Math.ceil(vh / ROW_H));
    let top = Math.floor(box.scrollTop / ROW_H) - OVERSCAN; if (top < 0) top = 0;
    const maxTop = Math.max(0, n - vis - OVERSCAN); if (top > maxTop) top = maxTop;
    const cnt = Math.min(vis + OVERSCAN*2, n - top);
    let h = '<tr class="vspace"><td colspan="' + C + '" style="height:' + (top * ROW_H) + 'px"></td></tr>';
    for (let i = top; i < top + cnt; i++) h += s0RowHTML(i);
    h += '<tr class="vspace"><td colspan="' + C + '" style="height:' + (Math.max(0, n - top - cnt) * ROW_H) + 'px"></td></tr>';
    tb.innerHTML = h;
  }
  function s0RowHTML(i){
    const x = getUiRow(i);
    if (!x) return '';
    const pr = N(x.Total) - N(x.Jumlah) * N(x['Harga Beli']);
    const totVal = N(x.Total);
    const margin = totVal !== 0 ? (pr / totVal) * 100 : null;
    const lowMargin = margin !== null && margin < 3;
    const all = {no:i+1,tgl:fmtTgl(x.Tanggal),faktur:x['No. Faktur'],produk:x.Produk,qty:x.Jumlah,satuan:x.Satuan||'',
      hjual:rp(x['Harga Jual']),hargabeli:rp(x['Harga Beli']),disc:rp(x.Discount),total:rp(x.Total),
      hpp:rp(N(x.Jumlah) * N(x['Harga Beli'])),profit:rp(pr),sales:x.Sales,bayar:x.Pembayaran,
      customer:x.Customer||'',kdcustomer:x['Kd Customer']||'',alamat:x.Alamat||''};
    const cells = s0Vis.map(c => {
      const v = all[c.k], cls = (typeof v === 'number') ? 'num' : '';
      const title = (typeof v === 'string' && v.length > 10) ? ' title="' + v.replace(/"/g,'&quot;') + '"' : '';
      return '<td class="' + cls + '"' + title + '>' + v + '</td>';
    }).join('');
    const clickAttr = lowMargin ? ' onclick="showMarginDetail(' + i + ')" title="Klik untuk lihat detail anomali margin"' : '';
    return '<tr class="vrow' + (lowMargin ? ' low-margin' : '') + '"' + clickAttr + '>' + cells + '</tr>';
  }

  /* ------------- detail anomali margin (klik baris merah) ------------- */
  const MARGIN_MIN = 3; // persen
  function showMarginDetail(i){
    const x = getUiRow(i);
    if (!x) return;
    const qty = N(x.Jumlah);
    const hjual = N(x['Harga Jual']);
    const hbeli = N(x['Harga Beli']);
    const disc = N(x.Discount);
    const total = N(x.Total);
    const hpp = qty * hbeli;
    const profit = total - hpp;
    const margin = total !== 0 ? (profit / total) * 100 : 0;
    // harga jual satuan minimum agar margin = MARGIN_MIN%, dengan asumsi qty & harga beli tetap
    // total_min = hpp / (1 - MARGIN_MIN/100)
    const totalMin = hpp / (1 - MARGIN_MIN / 100);
    const hjualMinSatuan = qty ? totalMin / qty : 0;
    const kurangProfit = totalMin - total;

    const rows = [
      ['Tanggal', fmtTgl(x.Tanggal)],
      ['No. Faktur', x['No. Faktur'] || '-'],
      ['Produk', x.Produk || '-'],
      ['Qty', qty.toLocaleString('id-ID') + (x.Satuan ? ' ' + x.Satuan : '')],
      ['Harga Beli (satuan)', rp(hbeli)],
      ['Harga Jual (satuan)', rp(hjual)],
      ['Discount', rp(disc)],
      ['Total Jual', rp(total)],
      ['HPP (Beli x Qty)', rp(hpp)],
      ['Profit Aktual', rp(profit)],
      ['Margin Aktual', margin.toFixed(2) + ' %'],
    ];
    const rowsHtml = rows.map(r =>
      '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding:7px 10px;border-bottom:1px solid #eef1f5">' +
        '<span style="color:#64748b;flex:0 0 auto">' + r[0] + '</span>' +
        '<span style="font-weight:700;color:#172033;text-align:right">' + r[1] + '</span>' +
      '</div>'
    ).join('');

    const saranRow = (label, val) =>
      '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding:6px 0">' +
        '<span style="color:#7f1d1d">' + label + '</span>' +
        '<span style="font-weight:800;color:#7f1d1d;text-align:right;white-space:nowrap">' + val + '</span>' +
      '</div>';
    const saranHtml =
      '<div style="margin-top:14px;padding:12px 14px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px">' +
        '<div style="font-weight:800;color:#b91c1c;margin-bottom:6px">⚠ Anomali: Margin di bawah ' + MARGIN_MIN + '%</div>' +
        saranRow('Agar margin minimal ' + MARGIN_MIN + '%, Total Jual seharusnya', rp(totalMin)) +
        saranRow('Harga Jual satuan seharusnya (qty tetap)', rp(hjualMinSatuan)) +
        saranRow('Kekurangan profit dari target', rp(kurangProfit)) +
      '</div>';

    const html =
      '<div id="marginDetailOverlay" onclick="if(event.target===this) closeMarginDetail()" style="position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:9998;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box">' +
        '<div style="background:#fff;border-radius:12px;max-width:520px;width:100%;max-height:86vh;overflow-y:auto;box-shadow:0 12px 40px rgba(0,0,0,.3);box-sizing:border-box">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid #e2e8f0;position:sticky;top:0;background:#fff">' +
            '<div style="font-weight:800;color:#172033;font-size:14px">Detail Anomali Margin</div>' +
            '<button onclick="closeMarginDetail()" style="background:#f1f5f9;color:#334155;border-radius:6px;padding:4px 10px;font-weight:700">✕</button>' +
          '</div>' +
          '<div style="padding:6px 16px 16px;box-sizing:border-box;font-size:13px">' +
            '<div style="border:1px solid #eef1f5;border-radius:8px;overflow:hidden">' + rowsHtml + '</div>' +
            saranHtml +
          '</div>' +
        '</div>' +
      '</div>';
    const wrap = document.createElement('div');
    wrap.id = 'marginDetailWrap';
    wrap.innerHTML = html;
    document.body.appendChild(wrap);
  }
  function closeMarginDetail(){
    const el = document.getElementById('marginDetailWrap');
    if (el) el.remove();
  }

  /* Paginasi tab rekap (siap data setahun / banyak produk) */
  let rekapPage = { s1:0, s2:0, s3:0, s5:0, s6:0, s8:0, s9:0 };
  const REKAP_PAGE_SIZE = 60;
  function rekapPagerHtml(tab, total){
    const pages = Math.max(1, Math.ceil(total / REKAP_PAGE_SIZE));
    let page = rekapPage[tab] || 0;
    if (page > pages - 1) page = pages - 1;
    if (page < 0) page = 0;
    rekapPage[tab] = page;
    if (total <= REKAP_PAGE_SIZE) return '';
    const from = page * REKAP_PAGE_SIZE + 1;
    const to = Math.min(total, (page + 1) * REKAP_PAGE_SIZE);
    return '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:8px 4px 10px;font-size:12px;color:#475569">' +
      '<span>Menampilkan <b>' + from + '–' + to + '</b> dari <b>' + total.toLocaleString('id-ID') + '</b> baris</span>' +
      '<span style="display:flex;gap:6px;align-items:center">' +
        '<button type="button" ' + (page<=0?'disabled ':'') + 'onclick="rekapGo(\'' + tab + '\',' + (page-1) + ')" style="padding:5px 10px;border-radius:6px;border:1px solid #cbd5e1;background:#fff;cursor:pointer">‹ Prev</button>' +
        '<span>Halaman <b>' + (page+1) + '</b> / ' + pages + '</span>' +
        '<button type="button" ' + (page>=pages-1?'disabled ':'') + 'onclick="rekapGo(\'' + tab + '\',' + (page+1) + ')" style="padding:5px 10px;border-radius:6px;border:1px solid #cbd5e1;background:#fff;cursor:pointer">Next ›</button>' +
      '</span></div>';
  }
  function rekapGo(tab, page){
    rekapPage[tab] = Math.max(0, page|0);
    viewCache[tab] = null;
    const btn = document.querySelector('.tabs button.active');
    show(tab, btn);
  }
  function sliceRekap(tab, arr){
    const page = rekapPage[tab] || 0;
    const start = page * REKAP_PAGE_SIZE;
    return arr.slice(start, start + REKAP_PAGE_SIZE);
  }

  /* ------------- Sales per Produk: Qty per Sales per Tanggal ------------- */
  let s7DateFilter = '';

  function buildS7Pivot(dateFilter){
    const byDate = new Map();
    const n = filteredRows.length;
    for (let i = 0; i < n; i++){
      const x = getUiRow(i);
      if (!x) continue;
      const d = toDate(x.Tanggal ?? x.tanggal);
      if (!d) continue;
      const y = d.getFullYear(), m = d.getMonth()+1, day = d.getDate();
      const key = y + '-' + String(m).padStart(2,'0') + '-' + String(day).padStart(2,'0');
      if (dateFilter && key !== dateFilter) continue;
      const produk = String(x.Produk ?? x.produk ?? '').trim() || '(Tanpa Produk)';
      const qty = N(x.Jumlah ?? x.jumlah);
      const salesName = normSales(x.Sales ?? x.sales);
      let g = byDate.get(key);
      if (!g){
        g = { ts: new Date(y, m-1, day).getTime(), label: fmtTgl(d), products: new Map() };
        byDate.set(key, g);
      }
      let p = g.products.get(produk);
      if (!p){
        p = { q: {}, total: 0 };
        SO_S7.forEach(s => { p.q[s] = 0; });
        g.products.set(produk, p);
      }
      if (SO_S7.includes(salesName)){
        p.q[salesName] = (p.q[salesName] || 0) + qty;
      }
      p.total += qty;
    }
    const dates = [...byDate.entries()].sort((a,b) => b[1].ts - a[1].ts);
    const rows = [];
    dates.forEach(([key, g]) => {
      const prods = [...g.products.entries()].sort((a,b) => a[0].localeCompare(b[0], 'id'));
      prods.forEach(([produk, p], idx) => {
        rows.push({
          dateKey: key,
          dateLabel: g.label,
          isFirst: idx === 0,
          span: prods.length,
          produk,
          q: p.q,
          total: p.total
        });
      });
    });
    const grand = {};
    SO_S7.forEach(s => { grand[s] = 0; });
    let grandTotal = 0;
    rows.forEach(r => {
      SO_S7.forEach(s => { grand[s] += (r.q[s] || 0); });
      grandTotal += r.total;
    });
    return { rows, grand, grandTotal };
  }

  function s7DateOptionsHtml(){
    const set = new Set();
    const n = filteredRows.length;
    for (let i = 0; i < n; i++){
      const x = getUiRow(i);
      if (!x) continue;
      const d = toDate(x.Tanggal ?? x.tanggal);
      if (!d) continue;
      const key = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
      set.add(key);
    }
    const keys = [...set].sort();
    return '<option value="">Semua tanggal</option>' +
      keys.map(k => {
        const [y,m,dd] = k.split('-').map(Number);
        const label = new Date(y, m-1, dd).toLocaleDateString('id-ID');
        return '<option value="' + k + '"' + (s7DateFilter === k ? ' selected' : '') + '>' + label + '</option>';
      }).join('');
  }

  function setS7DateFilter(val){
    s7DateFilter = val || '';
    viewCache['s7'] = null;
    const btn = document.querySelector('.tabs button.active');
    show('s7', btn);
  }

  function renderS7(){
    const pivot = buildS7Pivot(s7DateFilter);
    const head = ['TGL','PRODUK', ...SO_S7.map(s => s === 'PARIMIN' ? 'PRTIMIN' : s), 'TOTAL QTY'];
    let body = '';
    if (!pivot.rows.length){
      body = '<tr><td colspan="' + head.length + '" style="text-align:center;padding:28px;color:#64748b">Tidak ada data untuk filter saat ini.</td></tr>';
    } else {
      pivot.rows.forEach(r => {
        body += '<tr>';
        if (r.isFirst){
          body += '<td rowspan="' + r.span + '" style="vertical-align:top;font-weight:600;white-space:nowrap">' + r.dateLabel + '</td>';
        }
        body += '<td>' + r.produk + '</td>';
        SO_S7.forEach(s => {
          const v = r.q[s] || 0;
          body += '<td class="num">' + (v ? v.toLocaleString('id-ID') : '') + '</td>';
        });
        body += '<td class="num" style="font-weight:700">' + (r.total ? r.total.toLocaleString('id-ID') : '') + '</td>';
        body += '</tr>';
      });
    }
    const foot = '<tr><td class="num" colspan="2">TOTAL</td>' +
      SO_S7.map(s => '<td class="num">' + (pivot.grand[s] ? pivot.grand[s].toLocaleString('id-ID') : '0') + '</td>').join('') +
      '<td class="num">' + (pivot.grandTotal ? pivot.grandTotal.toLocaleString('id-ID') : '0') + '</td></tr>';

    return '<div class="tablebox"><table><thead><tr>' +
      head.map(h => '<th>' + h + '</th>').join('') +
      '</tr></thead><tbody>' + body + '</tbody><tfoot>' + foot + '</tfoot></table></div>';
  }

  function renderTab(t){
    const SO2 = R.SO2 || SO;
    if (t === 's7'){
      return renderS7();
    } else if (t === 's1'){
      const n = SO2.length;
      const h = ['PRODUK', ...SO2, 'TOTAL QTY','SATUAN','HARGA BELI','HARGA JUAL','BELI X QTY','JUAL X QTY','PROFIT'];
      const pageRows = sliceRekap('s1', R.s1 || []);
      const d = pageRows.map(x => { const row = [x[0]]; for (let i = 1; i <= n; i++) row.push(x[i]); row.push(x[n+1],x[n+2],x[n+3],x[n+4],rp(x[n+5]),rp(x[n+6]),rp(x[n+7])); return row });
      const sums = SO2.map((s,i) => (R.s1||[]).reduce((a,x) => a + (x[1+i]||0), 0));
      return reportBar('s1','Rekap per Produk') + rekapPagerHtml('s1', (R.s1||[]).length) + tbl(h, d, ['TOTAL', ...sums, R.qty, '', '', '', rp(R.hpp), rp(R.sales), rp(R.profit)]);
    } else if (t === 's2'){
      const h = ['PRODUK','NOMINAL PENJUALAN CASH','NOMINAL PENJUALAN TEMPO','PROFIT TEMPO','PROFIT CASH','TOTAL NOMINAL PENJUALAN','TOTAL PROFIT'];
      const pageRows = sliceRekap('s2', R.s2 || []);
      const d = pageRows.map(x => [x[0],rp(x[1]),rp(x[2]),rp(x[3]),rp(x[4]),rp(x[5]),rp(x[6])]);
      return reportBar('s2','Profit Per Pembayaran') + rekapPagerHtml('s2', (R.s2||[]).length) + tbl(h, d, ['TOTAL', rp(R.cs), rp(R.ts), rp(R.tp), rp(R.cp), rp(R.sales), rp(R.profit)]);
    } else if (t === 's3'){
      const h = ['NO','PRODUK','QTY','TOTAL PENJUALAN','TOTAL HPP','HARGA JUAL','HARGA BELI','PROFIT'];
      const pageRows = sliceRekap('s3', R.s3 || []);
      const base = (rekapPage.s3 || 0) * REKAP_PAGE_SIZE;
      const d = pageRows.map((x,i) => [base+i+1, x[0], x[1], rp(x[2]), rp(x[3]), x[4], x[5], rp(x[6])]);
      return reportBar('s3','Profit Penjualan per Produk') + rekapPagerHtml('s3', (R.s3||[]).length) + tbl(h, d, ['TOTAL', '', R.qty, rp(R.sales), rp(R.hpp), '', '', rp(R.profit)]);
    } else if (t === 's4'){
      const h = ['SALES','JUMLAH FAKTUR','TOTAL QTY','TOTAL PENJUALAN','TOTAL HPP','TOTAL PROFIT'];
      const pack = arr => arr.map(x => [x[0], x[1], x[2], rp(x[3]), rp(x[4]), rp(x[5])]);
      const tot  = arr => ['TOTAL', arr.reduce((a,x)=>a+x[1],0), arr.reduce((a,x)=>a+x[2],0), rp(arr.reduce((a,x)=>a+x[3],0)), rp(arr.reduce((a,x)=>a+x[4],0)), rp(arr.reduce((a,x)=>a+x[5],0))];
      return reportBar('s4','Rekap per Sales') +
             '<div style="margin-bottom:6px;font-weight:bold;color:#1f4e78">MINYAK FITRI</div>' +
             tbl(h, pack(R.s4fitri||[]), tot(R.s4fitri||[])) +
             '<div style="margin:36px 0 6px;font-weight:bold;color:#1f4e78">RUPA RUPA</div>' +
             tbl(h, pack(R.s4rupa||[]), tot(R.s4rupa||[]));
    } else if (t === 's6'){
      return reportBar('s6','Rekap per Faktur') + renderRekapPerFaktur();
    } else if (t === 's8'){
      const groups = buildFakturGroups();
      const h = ['NO','TANGGAL','NO. FAKTUR','SALES','CUSTOMER','PEMBAYARAN','NOMINAL FAKTUR','PROFIT FAKTUR','MARGIN %'];
      const pageRows = sliceRekap('s8', groups);
      const base = (rekapPage.s8 || 0) * REKAP_PAGE_SIZE;
      const d = pageRows.map((g,i) => [
        base+i+1, fmtTgl(g.tgl), g.faktur, g.sales || '', g.customer || '', g.bayar || '',
        rp(g.nominal), rp(g.profit), (g.nominal ? (Math.round(g.profit/g.nominal*10000)/100) : 0).toLocaleString('id-ID') + ' %'
      ]);
      const totNominal = groups.reduce((a,g)=>a+g.nominal,0);
      const totProfit = groups.reduce((a,g)=>a+g.profit,0);
      const avgM = totNominal ? (totProfit/totNominal*100) : 0;
      return reportBar('s8','Profit per Faktur') + rekapPagerHtml('s8', groups.length) +
        tbl(h, d, ['TOTAL','','','','','', rp(totNominal), rp(totProfit), (Math.round(avgM*100)/100).toLocaleString('id-ID') + ' %']);
    } else if (t === 's5'){
      const h = ['NO','PRODUK','QTY','SATUAN','TOTAL PENJUALAN','TOTAL HPP','PROFIT','MARGIN %'];
      const pageRows = sliceRekap('s5', R.s5 || []);
      const base = (rekapPage.s5 || 0) * REKAP_PAGE_SIZE;
      const d = pageRows.map((x,i) => [base+i+1, x[0], x[1], x[2], rp(x[3]), rp(x[4]), rp(x[5]), (Math.round(x[6]*100)/100).toLocaleString('id-ID') + ' %']);
      const avgM = R.sales ? (R.profit/R.sales*100) : 0;
      return reportBar('s5','Margin % per Produk') + rekapPagerHtml('s5', (R.s5||[]).length) + tbl(h, d, ['TOTAL', '', R.qty, '', rp(R.sales), rp(R.hpp), rp(R.profit), (Math.round(avgM*100)/100).toLocaleString('id-ID') + ' %']);
    } else if (t === 's9'){
      return renderS9();
    } else if (t === 's10'){
      return renderDataBulanan();
    }
  }

  /* ------------- Data Harga: harga terendah/tertinggi per produk (apa adanya, tanpa rata-rata) ------------- */
  function monthFilterLabel(){
    const fm = document.getElementById('filterMonth');
    return fm && fm.value ? (fm.options[fm.selectedIndex]?.text || fm.value) : 'Semua bulan';
  }
  function renderS9(){
    const list = R.s9 || [];
    const pageRows = sliceRekap('s9', list);
    const caption = '<div style="font-weight:700;color:#1f4e78;margin-bottom:8px">' + monthFilterLabel() + ' ( filter bulan )</div>';
    let body = '';
    if (!pageRows.length){
      body = '<tr><td colspan="7" style="text-align:center;padding:28px;color:#64748b">Tidak ada data untuk filter saat ini.</td></tr>';
    } else {
      pageRows.forEach(x => {
        const [produk, satuan, bmin, bmax, jmin, jmax, hbChange] = x;
        const ket = hbChange
          ? ((hbChange.dir === 'naik' ? 'Naik' : 'Turun') + ' sejak ' + fmtTgl(new Date(hbChange.ts)))
          : '';
        body += '<tr>' +
          '<td>' + produk + '</td>' +
          '<td>' + (satuan || '') + '</td>' +
          '<td class="num">' + rp(bmin) + '</td>' +
          '<td class="num">' + rp(bmax) + '</td>' +
          '<td class="num">' + rp(jmin) + '</td>' +
          '<td class="num">' + rp(jmax) + '</td>' +
          '<td>' + ket + '</td>' +
        '</tr>';
      });
    }
    const table = '<div class="tablebox"><table class="s9table"><thead>' +
      '<tr>' +
        '<th class="s9-h0" rowspan="2">Produk</th>' +
        '<th class="s9-h0" rowspan="2">Satuan</th>' +
        '<th class="s9-h1" colspan="2">Harga Beli</th>' +
        '<th class="s9-h1" colspan="2">Harga Jual</th>' +
        '<th class="s9-h0" rowspan="2">Ket</th>' +
      '</tr>' +
      '<tr>' +
        '<th class="s9-h2">Terendah</th><th class="s9-h2">Tertinggi</th>' +
        '<th class="s9-h2">Terendah</th><th class="s9-h2">Tertinggi</th>' +
      '</tr>' +
      '</thead><tbody>' + body + '</tbody></table></div>';
    return reportBar('s9','Data Harga') + caption + rekapPagerHtml('s9', list.length) + table;
  }

  /* ------------- Data Bulanan: rekap per bulan Fitri vs Rupa Rupa ------------- */
  function monthLabelShort(key){
    if (!key) return '';
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('id-ID', { month: 'long' }).toLowerCase();
  }
  function renderDataBulanan(){
    const byMonth = new Map();
    const n = filteredRows.length;
    for (let i = 0; i < n; i++){
      const x = getUiRow(i);
      if (!x) continue;
      const mk = monthKey(x.Tanggal || x.tanggal);
      if (!mk) continue;
      let m = byMonth.get(mk);
      if (!m){
        m = { fitri: { q:0, n:0, p:0 }, rupa: { q:0, n:0, p:0 } };
        byMonth.set(mk, m);
      }
      const j = N(x.Jumlah);
      const t = N(x.Total);
      const pr = t - j * N(x['Harga Beli']);
      const bucket = isFitriProduct(x.Produk) ? m.fitri : m.rupa;
      bucket.q += j;
      bucket.n += t;
      bucket.p += pr;
    }
    const months = [...byMonth.keys()].sort();
    let totFitriQ = 0, totFitriN = 0, totFitriP = 0;
    let totRupaQ = 0, totRupaN = 0, totRupaP = 0;
    let body = '';
    if (!months.length){
      body = '<tr><td colspan="9" style="text-align:center;padding:28px;color:#64748b">Tidak ada data untuk filter saat ini.</td></tr>';
    } else {
      months.forEach(mk => {
        const m = byMonth.get(mk);
        const f = m.fitri, r = m.rupa;
        totFitriQ += f.q; totFitriN += f.n; totFitriP += f.p;
        totRupaQ += r.q; totRupaN += r.n; totRupaP += r.p;
        const totN = f.n + r.n;
        const totP = f.p + r.p;
        body += '<tr>' +
          '<td>' + monthLabelShort(mk) + '</td>' +
          '<td class="num">' + (f.q ? f.q.toLocaleString('id-ID') : '') + '</td>' +
          '<td class="num">' + (f.n ? rp(f.n) : '') + '</td>' +
          '<td class="num">' + (f.p ? rp(f.p) : '') + '</td>' +
          '<td class="num">' + (r.q ? r.q.toLocaleString('id-ID') : '') + '</td>' +
          '<td class="num">' + (r.n ? rp(r.n) : '') + '</td>' +
          '<td class="num">' + (r.p ? rp(r.p) : '') + '</td>' +
          '<td class="num">' + (totN ? rp(totN) : '') + '</td>' +
          '<td class="num">' + (totP ? rp(totP) : '') + '</td>' +
        '</tr>';
      });
    }
    const totNAll = totFitriN + totRupaN;
    const totPAll = totFitriP + totRupaP;
    const foot = months.length
      ? '<tr>' +
          '<td>TOTAL</td>' +
          '<td class="num">' + totFitriQ.toLocaleString('id-ID') + '</td>' +
          '<td class="num">' + rp(totFitriN) + '</td>' +
          '<td class="num">' + rp(totFitriP) + '</td>' +
          '<td class="num">' + totRupaQ.toLocaleString('id-ID') + '</td>' +
          '<td class="num">' + rp(totRupaN) + '</td>' +
          '<td class="num">' + rp(totRupaP) + '</td>' +
          '<td class="num">' + rp(totNAll) + '</td>' +
          '<td class="num">' + rp(totPAll) + '</td>' +
        '</tr>'
      : '';
    const caption = '<div style="font-weight:700;color:#1f4e78;margin-bottom:8px">Rekap Data Bulanan (mengikuti filter aktif)</div>';
    const table = '<div class="tablebox"><table class="s10table"><thead>' +
      '<tr>' +
        '<th class="s10-h0" rowspan="2">Bulan</th>' +
        '<th class="s10-h1" colspan="3">Produk Fitri</th>' +
        '<th class="s10-h1" colspan="3">Produk Rupa rupa</th>' +
        '<th class="s10-h0" rowspan="2">Total<br>Nominal Penjualan</th>' +
        '<th class="s10-h0" rowspan="2">Total<br>Profit</th>' +
      '</tr>' +
      '<tr>' +
        '<th class="s10-h2">Qty</th><th class="s10-h2">Nominal Penjualan</th><th class="s10-h2">Profit</th>' +
        '<th class="s10-h2">Qty</th><th class="s10-h2">Nominal Penjualan</th><th class="s10-h2">Profit</th>' +
      '</tr>' +
      '</thead><tbody>' + body + '</tbody>' +
      (foot ? '<tfoot>' + foot + '</tfoot>' : '') +
      '</table></div>';
    return reportBar('s10','Data Bulanan') + caption + table;
  }

  /* ------------- Rekap per Faktur (baris detail + nominal/profit per faktur) ------------- */
  function buildFakturRows(){
    // Kelompokkan baris terfilter berdasarkan No. Faktur, urut tanggal lalu faktur
    const groups = new Map(); // faktur -> {items:[], nominal, profit, tgl, sales, bayar, customer}
    const n = filteredRows.length;
    for (let i = 0; i < n; i++){
      const x = getUiRow(i);
      if (!x) continue;
      const nf = String(x['No. Faktur'] ?? x.faktur ?? '').trim() || '(Tanpa Faktur)';
      const total = N(x.Total);
      const pr = total - N(x.Jumlah) * N(x['Harga Beli']);
      let g = groups.get(nf);
      if (!g){
        g = {
          faktur: nf,
          items: [],
          nominal: 0,
          profit: 0,
          tgl: x.Tanggal,
          ts: x._ts || 0,
          sales: x.Sales || '',
          bayar: x.Pembayaran || '',
          customer: x.Customer || ''
        };
        groups.set(nf, g);
      }
      g.items.push(x);
      g.nominal += total;
      g.profit += pr;
      // pakai tanggal paling awal dalam grup
      if (x._ts && (!g.ts || x._ts < g.ts)){ g.ts = x._ts; g.tgl = x.Tanggal; }
      if (!g.sales && x.Sales) g.sales = x.Sales;
      if (!g.bayar && x.Pembayaran) g.bayar = x.Pembayaran;
      if (!g.customer && x.Customer) g.customer = x.Customer;
    }
    // urut: tanggal terkini di atas, lalu no faktur
    const list = [...groups.values()].sort((a,b) => {
      if (a.ts !== b.ts) return (b.ts||0) - (a.ts||0);
      return String(a.faktur).localeCompare(String(b.faktur));
    });
    // flatten ke baris tampilan: baris pertama grup menampilkan nominal & profit
    const rows = [];
    list.forEach(g => {
      g.items.forEach((x, idx) => {
        rows.push({
          x,
          isFirst: idx === 0,
          span: g.items.length,
          nominal: g.nominal,
          profit: g.profit,
          faktur: g.faktur,
          sales: g.sales,
          bayar: g.bayar,
          customer: g.customer
        });
      });
    });
    return rows;
  }

  let fakturViewMode = 'card'; // 'table' | 'card'

  function setFakturViewMode(mode){
    fakturViewMode = (mode === 'card') ? 'card' : 'table';
    const tb = document.getElementById('fmTableBtn');
    const cb = document.getElementById('fmCardBtn');
    if (tb) tb.classList.toggle('active', fakturViewMode === 'table');
    if (cb) cb.classList.toggle('active', fakturViewMode === 'card');
    viewCache['s6'] = null;
    const btn = document.querySelector('.tabs button.active');
    show('s6', btn);
  }

  function buildFakturGroups(){
    const groups = new Map();
    const n = filteredRows.length;
    for (let i = 0; i < n; i++){
      const x = getUiRow(i);
      if (!x) continue;
      const nf = String(x['No. Faktur'] ?? x.faktur ?? '').trim() || '(Tanpa Faktur)';
      const total = N(x.Total);
      const pr = total - N(x.Jumlah) * N(x['Harga Beli']);
      let g = groups.get(nf);
      if (!g){
        g = {
          faktur: nf, items: [], nominal: 0, profit: 0,
          tgl: x.Tanggal, ts: x._ts || 0,
          sales: x.Sales || '', bayar: x.Pembayaran || '', customer: x.Customer || ''
        };
        groups.set(nf, g);
      }
      g.items.push(x);
      g.nominal += total;
      g.profit += pr;
      if (x._ts && (!g.ts || x._ts < g.ts)){ g.ts = x._ts; g.tgl = x.Tanggal; }
      if (!g.sales && x.Sales) g.sales = x.Sales;
      if (!g.bayar && x.Pembayaran) g.bayar = x.Pembayaran;
      if (!g.customer && x.Customer) g.customer = x.Customer;
    }
    return [...groups.values()].sort((a,b) => {
      if (a.ts !== b.ts) return (b.ts||0) - (a.ts||0);
      return String(a.faktur).localeCompare(String(b.faktur));
    });
  }

  function renderRekapPerFakturCards(){
    const list = buildFakturGroups();
    if (!list.length){
      return '<div style="text-align:center;padding:36px;color:#64748b">Belum ada data faktur.</div>';
    }
    const cards = list.map(g => {
      const bayarU = String(g.bayar || '').toUpperCase();
      const badgeCls = bayarU.includes('CASH') ? 'cash' : (bayarU.includes('TEMPO') ? 'tempo' : '');
      const items = g.items.map(x => {
        const prod = String(x.Produk || '').replace(/</g,'&lt;');
        const qty = N(x.Jumlah);
        const sat = x.Satuan || '';
        const line = rp(x.Total);
        return '<li><span class="fc-prod" title="' + prod.replace(/"/g,'&quot;') + '">' + prod +
          '</span><span class="fc-qty">' + qty + (sat ? ' ' + sat : '') +
          '</span><span class="fc-line">' + line + '</span></li>';
      }).join('');
      return '<div class="faktur-card">' +
        '<div class="fc-head">' +
          '<div class="fc-faktur">' + String(g.faktur).replace(/</g,'&lt;') + '</div>' +
          '<div class="fc-head-right">' +
            '<div class="fc-tgl">' + fmtTgl(g.tgl) + '</div>' +
            (g.bayar ? '<span class="fc-badge ' + badgeCls + '">' + String(g.bayar).replace(/</g,'&lt;') + '</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="fc-meta">' +
          (g.sales ? '<span>Sales <b>' + String(g.sales).replace(/</g,'&lt;') + '</b></span>' : '') +
          (g.customer ? '<span>Cust <b title="' + String(g.customer).replace(/"/g,'&quot;') + '">' + String(g.customer).replace(/</g,'&lt;') + '</b></span>' : '') +
        '</div>' +
        '<ul class="fc-items">' + items + '</ul>' +
        '<div class="fc-nums">' +
          '<div><div class="fc-num-label">Nominal</div><div class="fc-num-val">' + rp(g.nominal) + '</div></div>' +
          '<div style="text-align:right"><div class="fc-num-label">Profit</div><div class="fc-num-val profit">' + rp(g.profit) + '</div></div>' +
        '</div>' +
      '</div>';
    }).join('');
    const summary = '<div style="font-size:12px;color:#475569;margin:0 0 10px;font-weight:600">' +
      list.length.toLocaleString('id-ID') + ' faktur · Qty ' + (R.qty||0).toLocaleString('id-ID') +
      ' · Nominal ' + rp(R.sales) + ' · Profit ' + rp(R.profit) + '</div>';
    return summary + '<div class="faktur-cards">' + cards + '</div>';
  }

  function renderRekapPerFaktur(){
    if (fakturViewMode === 'card') return renderRekapPerFakturCards();
    const allRows = buildFakturRows();
    const totalLines = allRows.length;
    const pageRows = sliceRekap('s6', allRows);
    const base = (rekapPage.s6 || 0) * REKAP_PAGE_SIZE;

    const head = ['NO','TANGGAL','NO. FAKTUR','SALES','PRODUK','QTY','SATUAN','HARGA JUAL','DISC','TOTAL','NOMINAL FAKTUR','PROFIT PER FAKTUR','PEMBAYARAN','CUSTOMER'];
    let body = '';
    // Untuk rowspan: jika halaman memotong di tengah grup, nominal tetap ditampilkan di baris pertama yang muncul di halaman
    const shownFaktur = new Set();
    pageRows.forEach((row, i) => {
      const x = row.x;
      const no = base + i + 1;
      const tgl = fmtTgl(x.Tanggal);
      const produk = x.Produk || '';
      const qty = N(x.Jumlah);
      const satuan = x.Satuan || '';
      const hj = rp(x['Harga Jual']);
      const disc = rp(x.Discount);
      const total = rp(x.Total);
      const sales = x.Sales || row.sales || '';
      const bayar = x.Pembayaran || row.bayar || '';
      const cust = x.Customer || row.customer || '';
      const showAgg = row.isFirst || !shownFaktur.has(row.faktur);
      shownFaktur.add(row.faktur);
      const nomCell = showAgg ? ('<td class="num" style="font-weight:700">' + rp(row.nominal) + '</td>') : '<td class="num"></td>';
      const prCell  = showAgg ? ('<td class="num" style="font-weight:700">' + rp(row.profit) + '</td>') : '<td class="num"></td>';
      body += '<tr>' +
        '<td class="num">' + no + '</td>' +
        '<td>' + tgl + '</td>' +
        '<td>' + row.faktur + '</td>' +
        '<td>' + sales + '</td>' +
        '<td title="' + String(produk).replace(/"/g,'&quot;') + '">' + produk + '</td>' +
        '<td class="num">' + qty + '</td>' +
        '<td>' + satuan + '</td>' +
        '<td class="num">' + hj + '</td>' +
        '<td class="num">' + disc + '</td>' +
        '<td class="num">' + total + '</td>' +
        nomCell + prCell +
        '<td>' + bayar + '</td>' +
        '<td title="' + String(cust).replace(/"/g,'&quot;') + '">' + cust + '</td>' +
      '</tr>';
    });

    // Footer totals dari seluruh data terfilter
    const foot = '<tr>' +
      '<td class="num">TOTAL</td><td></td><td></td><td></td><td></td>' +
      '<td class="num">' + (R.qty || 0) + '</td><td></td><td></td><td></td>' +
      '<td class="num">' + rp(R.sales) + '</td>' +
      '<td class="num">' + rp(R.sales) + '</td>' +
      '<td class="num">' + rp(R.profit) + '</td>' +
      '<td></td><td></td>' +
    '</tr>';

    if (!totalLines){
      return '<div class="tablebox"><table><thead><tr>' + head.map(h => '<th>'+h+'</th>').join('') +
        '</tr></thead><tbody><tr><td colspan="14" style="text-align:center;padding:28px;color:#64748b">Belum ada data.</td></tr></tbody></table></div>';
    }

    return rekapPagerHtml('s6', totalLines) +
      '<div class="tablebox"><table><thead><tr>' + head.map(h => '<th>'+h+'</th>').join('') +
      '</tr></thead><tbody>' + body + '</tbody><tfoot>' + foot + '</tfoot></table></div>';
  }

  /* ------------- Save to Excel ------------- */
  function saveExcel(){
    if (!R.s1) return;
    const w = XLSX.utils.book_new();
    const add = (n,h,d,t) => { const ws = XLSX.utils.aoa_to_sheet([h, ...d, t]); XLSX.utils.book_append_sheet(w, ws, n) };
    const r = R, SO2 = r.SO2 || SO, n = SO2.length;
    const s0Head = ['NO','TANGGAL','NO. FAKTUR','PRODUK','QTY','SATUAN','HARGA JUAL','HARGA BELI','DISC','TOTAL','HPP','PROFIT','SALES','PEMBAYARAN','CUSTOMER','KODE CUSTOMER','ALAMAT'];
    const s0Data = filteredRows.map((_,i) => {
      const x = getUiRow(i);
      const pr = N(x.Total) - N(x.Jumlah) * N(x['Harga Beli']);
      return [i+1, fmtTgl(x.Tanggal), x['No. Faktur'], x.Produk, x.Jumlah, x.Satuan||'', x['Harga Jual'], x['Harga Beli'], x.Discount, x.Total,
        N(x.Jumlah) * N(x['Harga Beli']), pr, x.Sales, x.Pembayaran, x.Customer||'', x['Kd Customer']||'', x.Alamat||''];
    });
    add('Transaksi', s0Head, s0Data, ['TOTAL', '', '', '', r.qty, '', '', '', '', r.sales, r.hpp, r.profit, '', '', '', '', '']);
    const s1Head = ['PRODUK', ...SO2, 'TOTAL QTY','SATUAN','HARGA BELI','HARGA JUAL','BELI X QTY','JUAL X QTY','PROFIT'];
    const s1Data = r.s1.map(x => { const row = [x[0]]; for (let i = 1; i <= n; i++) row.push(x[i]); row.push(x[n+1],x[n+2],x[n+3],x[n+4],x[n+5],x[n+6],x[n+7]); return row });
    add('Rekap per Produk', s1Head, s1Data, ['TOTAL', ...SO2.map((s,i) => r.s1.reduce((a,x) => a + (x[1+i]||0), 0)), r.qty, '', '', '', r.hpp, r.sales, r.profit]);
    add('Profit Per Pembayaran', ['PRODUK','NOMINAL PENJUALAN CASH','NOMINAL PENJUALAN TEMPO','PROFIT TEMPO','PROFIT CASH','TOTAL NOMINAL PENJUALAN','TOTAL PROFIT'], r.s2, ['TOTAL',r.cs,r.ts,r.tp,r.cp,r.sales,r.profit]);
    add('Profit Penjualan per Produk', ['NO','PRODUK','QTY','TOTAL PENJUALAN','TOTAL HPP','HARGA JUAL','HARGA BELI','PROFIT'], r.s3.map((x,i) => [i+1, ...x]), ['TOTAL','',r.qty,r.sales,r.hpp,'','',r.profit]);
    const s4Head = ['SALES','JUMLAH FAKTUR','TOTAL QTY','TOTAL PENJUALAN','TOTAL HPP','TOTAL PROFIT'];
    const s4Tot = arr => ['TOTAL', arr.reduce((a,x)=>a+x[1],0), arr.reduce((a,x)=>a+x[2],0), arr.reduce((a,x)=>a+x[3],0), arr.reduce((a,x)=>a+x[4],0), arr.reduce((a,x)=>a+x[5],0)];
    add('MINYAK FITRI - Rekap per Sales', s4Head, r.s4fitri||[], s4Tot(r.s4fitri||[]));
    add('RUPA RUPA - Rekap per Sales', s4Head, r.s4rupa||[], s4Tot(r.s4rupa||[]));
    const avgM = r.sales ? (r.profit / r.sales * 100) : 0;
    add('Margin % per Produk', ['NO','PRODUK','QTY','SATUAN','TOTAL PENJUALAN','TOTAL HPP','PROFIT','MARGIN %'], r.s5.map((x,i) => [i+1, x[0], x[1], x[2], x[3], x[4], x[5], Math.round(x[6]*100)/100]), ['TOTAL','',r.qty,'',r.sales,r.hpp,r.profit,Math.round(avgM*100)/100]);
    // Rekap per Faktur
    {
      const fRows = buildFakturRows();
      const fHead = ['NO','TANGGAL','NO. FAKTUR','SALES','PRODUK','QTY','SATUAN','HARGA JUAL','DISC','TOTAL','NOMINAL FAKTUR','PROFIT PER FAKTUR','PEMBAYARAN','CUSTOMER'];
      const fData = fRows.map((row,i) => {
        const x = row.x;
        return [
          i+1,
          fmtTgl(x.Tanggal),
          row.faktur,
          x.Sales || row.sales || '',
          x.Produk || '',
          N(x.Jumlah),
          x.Satuan || '',
          N(x['Harga Jual']),
          N(x.Discount),
          N(x.Total),
          row.isFirst ? row.nominal : '',
          row.isFirst ? row.profit : '',
          x.Pembayaran || row.bayar || '',
          x.Customer || row.customer || ''
        ];
      });
      add('Rekap per Faktur', fHead, fData, ['TOTAL','','','','', r.qty, '', '', '', r.sales, r.sales, r.profit, '', '']);
    }
    XLSX.writeFile(w, 'Rekap_Penjualan_Hasil.xlsx');
  }

  /* ------------- Backup & Restore seluruh data aplikasi ------------- */
  let backupDirHandle = null;
  let backupFileInput = null;

  function toggleBackupMenu(){
    const w=document.getElementById('backupWrap');
    if(!w) return;
    w.classList.toggle('open');
    if(w.classList.contains('open')) updateBackupPanelStatus();
  }
  document.addEventListener('click', (e)=>{
    const w=document.getElementById('backupWrap');
    if(w && !w.contains(e.target)) w.classList.remove('open');
  });

  async function getBackupSnapshot(){
    if(useIDB && db){
      const snap=await gatherLocalSnapshot();
      if(snap) return snap;
    }
    return {tx:Array.isArray(rows)?rows.slice():[],meta:gudangData?[{key:'gudangData',value:gudangData}]:[]};
  }

  async function buildBackupObject(){
    const snapshot=await getBackupSnapshot();
    return {
      app:'Rekap Penjualan & Data Stok',
      backupVersion:2,
      createdAt:new Date().toISOString(),
      database:'rekapPenjualan_v1',
      tx:snapshot.tx||[],
      meta:snapshot.meta||[],
      theme:(()=>{try{return localStorage.getItem('rekap-theme')||'light'}catch(e){return 'light'}})()
    };
  }

  function backupFileName(){
    const d=new Date(),pad=n=>String(n).padStart(2,'0');
    return 'Backup_Rekap_'+d.getFullYear()+pad(d.getMonth()+1)+pad(d.getDate())+'_'+pad(d.getHours())+pad(d.getMinutes())+pad(d.getSeconds())+'.json';
  }

  function saveBackupLast(name){
    try{localStorage.setItem('rekap-last-backup',new Date().toISOString());localStorage.setItem('rekap-last-backup-name',name||'')}catch(e){}
    updateBackupPanelStatus();
  }

  async function updateBackupPanelStatus(){
    const el=document.getElementById('backupLastStatus');
    if(!el) return;
    let last='belum ada',name='';
    try{last=localStorage.getItem('rekap-last-backup')||'belum ada';name=localStorage.getItem('rekap-last-backup-name')||''}catch(e){}
    let folder='belum dipilih';
    if(backupDirHandle && backupDirHandle.name) folder=backupDirHandle.name;
    el.textContent='Backup terakhir: '+(last==='belum ada'?'belum ada':new Date(last).toLocaleString('id-ID'))+(name?' • '+name:'')+' • Folder Google Drive '+folder+'.';
    const cs=document.getElementById('backupCloudStatus');
    if(cs) cs.textContent=(document.getElementById('cloudSyncStatus')?.textContent)||'Status cloud mengikuti sinkronisasi aplikasi.';
  }

  async function chooseBackupFolder(){
    if(!window.showDirectoryPicker){
      alert('Browser ini belum mendukung pemilihan folder langsung. Gunakan “Unduh File Backup (manual)” atau Chrome/Edge versi terbaru.');
      return;
    }
    try{
      const h=await window.showDirectoryPicker({mode:'readwrite'});
      backupDirHandle=h;
      try{localStorage.setItem('rekap-backup-folder-name',h.name||'')}catch(e){}
      await updateBackupPanelStatus();
      setStatus('Folder backup dipilih: '+(h.name||'Google Drive'));
    }catch(e){
      if(e && e.name!=='AbortError') alert('Pemilihan folder dibatalkan/gagal: '+(e.message||e));
    }
  }

  async function ensureBackupFolder(){
    if(backupDirHandle) {
      try{
        const perm=await backupDirHandle.queryPermission({mode:'readwrite'});
        if(perm==='granted') return true;
        const req=await backupDirHandle.requestPermission({mode:'readwrite'});
        return req==='granted';
      }catch(e){ return false; }
    }
    await chooseBackupFolder();
    return !!backupDirHandle;
  }

  async function backupNowToDrive(){
    try{
      const ok=await ensureBackupFolder();
      if(!ok){ alert('Pilih Folder Google Drive terlebih dahulu.'); return; }
      const backup=await buildBackupObject();
      const name=backupFileName();
      const fh=await backupDirHandle.getFileHandle(name,{create:true});
      const writable=await fh.createWritable();
      await writable.write(JSON.stringify(backup,null,2));
      await writable.close();
      saveBackupLast(name);
      setStatus('Backup berhasil disimpan ke folder: '+backupDirHandle.name+' ('+(backup.tx.length||0).toLocaleString('id-ID')+' transaksi).');
      alert('Backup berhasil disimpan ke Google Drive.\n\nFile: '+name);
    }catch(e){
      console.error('Backup ke Drive gagal',e);
      alert('Backup ke Google Drive gagal: '+(e.message||e));
    }
  }

  async function downloadBackupFile(){
    try{
      const backup=await buildBackupObject(),name=backupFileName();
      const blob=new Blob([JSON.stringify(backup,null,2)],{type:'application/json;charset=utf-8'});
      const url=URL.createObjectURL(blob),a=document.createElement('a');
      a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
      saveBackupLast(name);
      setStatus('File backup manual berhasil dibuat: '+name);
    }catch(e){alert('Backup gagal: '+(e.message||e));}
  }

  async function restoreBackupObject(backup){
    if(!backup || !Array.isArray(backup.tx)) throw new Error('Format file backup tidak dikenali.');
    if(!confirm('Restore akan mengganti data lokal aplikasi dengan isi backup ini. Lanjutkan?')) return false;
    if(!useIDB || !db) throw new Error('Penyimpanan lokal belum siap.');
    isSyncingFromCloud=true;
    try{
      await db.tx.clear();
      if(backup.tx.length) await db.tx.bulkPut(backup.tx);
      await db.meta.clear();
      if(Array.isArray(backup.meta) && backup.meta.length) await db.meta.bulkPut(backup.meta);
    }finally{isSyncingFromCloud=false;}
    await restoreFromDB();
    await loadGudangFromDB();
    await refreshAfterDataChange();
    if(sbClient) schedulePush();
    setStatus('Restore berhasil: '+backup.tx.length.toLocaleString('id-ID')+' transaksi.');
    return true;
  }

  async function restoreFromDriveFolder(){
    try{
      const ok=await ensureBackupFolder();
      if(!ok){alert('Pilih Folder Google Drive terlebih dahulu.');return;}
      const files=[];
      for await(const [name,handle] of backupDirHandle.entries()){
        if(handle.kind==='file' && /^Backup_Rekap_.*\.json$/i.test(name)) files.push({name,handle});
      }
      if(!files.length){alert('Tidak ditemukan file Backup_Rekap_*.json di folder tersebut.');return;}
      files.sort((a,b)=>b.name.localeCompare(a.name));
      const chosen=files[0];
      const f=await chosen.handle.getFile();
      const backup=JSON.parse(await f.text());
      if(confirm('File backup terbaru yang ditemukan:\n\n'+chosen.name+'\n\nRestore file ini?')) await restoreBackupObject(backup);
    }catch(e){
      console.error('Restore folder gagal',e);
      alert('Restore dari folder gagal: '+(e.message||e));
    }
  }

  function restoreFromBackupFile(){
    if(backupFileInput) backupFileInput.remove();
    const input=document.createElement('input');
    backupFileInput=input;input.type='file';input.accept='.json,application/json';input.style.display='none';
    input.onchange=async()=>{
      const file=input.files&&input.files[0];
      if(!file) return;
      try{const backup=JSON.parse(await file.text());await restoreBackupObject(backup);}
      catch(e){alert('File backup tidak dapat dibaca: '+(e.message||e));}
      finally{input.remove();backupFileInput=null;}
    };
    document.body.appendChild(input);input.click();
  }

  async function backupUploadCloud(){
    try{
      if(!sbClient){alert('Cloud belum terhubung. Coba refresh halaman.');return;}
      if(!useIDB || !db){alert('Penyimpanan lokal belum siap. Coba refresh halaman.');return;}
      setCloudStatus('Mengunggah data device ini…');
      const result = await pushToCloud();
      if(result && result.skipped) return;
      await updateBackupPanelStatus();
      setStatus('Data device ini berhasil di-upload ke cloud.');
      alert('Upload berhasil. Data device ini sudah tersimpan di cloud.');
    }catch(e){
      console.error('Upload cloud gagal:',e);
      setCloudStatus('Upload gagal');
      await updateBackupPanelStatus();
      alert('Upload cloud gagal.\n\n'+(e.message||e)+'\n\nJika pesan menyebut tabel app_sync, RLS, atau permission, berarti pengaturan database Supabase perlu diperbaiki.');
    }
  }

  async function backupPullCloud(){
    try{
      if(!sbClient){alert('Cloud belum terhubung.');return;}
      if(!confirm('Data lokal device ini akan diganti dengan data terbaru dari cloud. Lanjutkan?')) return;
      await pullFromCloud({silent:false});
      await updateBackupPanelStatus();
    }catch(e){alert('Ambil data dari cloud gagal: '+(e.message||e));}
  }

  // Kompatibilitas dengan pemanggilan lama.

  /* ------------- restore persisted state from IndexedDB on load ------------- */
  async function restoreFromDB(){
    if (!useIDB) return;
    try {
      const total = await db.tx.count();
      if (!total) return;
      const metaFilters = await db.meta.get('filters');
      if (metaFilters && metaFilters.value) {
        filters = Object.assign({month:'',sales:'',product:'',payment:'',dateFrom:'',dateTo:'',kdCustomer:'',q:''}, metaFilters.value);
      }
      const monthsMeta = ((await db.meta.get('months')) || {}).value || [];
      // Saat pertama dibuka / bulan kosong: pakai bulan terkini
      if (!filters.month) filters.month = pickLatestMonth(monthsMeta);
      populateFiltersFromMeta({
        products: ((await db.meta.get('products')) || {}).value || [],
        sales:    ((await db.meta.get('sales'))    || {}).value || [],
        months:   monthsMeta
      });
      document.getElementById('summary').style.display = 'block';
      document.getElementById('result').style.display   = 'block';
      document.getElementById('save').disabled          = false;
      buildColPicker();
      await applyFilters();
      show('s6', document.querySelector('.tabs button.active') || document.querySelector('.tabs button'));
      setStatus('Data dari IndexedDB dimuat: ' + total.toLocaleString('id-ID') + ' baris (persistensi aktif).');
    } catch(e){
      console.warn('restoreFromDB gagal', e);
    }
  }

  /* ------------- Data Gudang (stok minyak) ------------- */
  const nfQty = x => (x === null || x === undefined || x === '') ? '-' : Math.round(N(x)).toLocaleString('id-ID');
  const gudangFmtDate = (d) => d instanceof Date && !isNaN(d.getTime())
    ? String(d.getUTCDate()).padStart(2,'0') + '/' + String(d.getUTCMonth()+1).padStart(2,'0') + '/' + d.getUTCFullYear()
    : String(d ?? '');

  function toggleGudangDd(){ document.getElementById('gudangDd').classList.toggle('open') }
  function closeGudangDd(){ document.getElementById('gudangDd').classList.remove('open') }

  /* ------------- Cek: Penjualan FITRI vs Output Gudang ------------- */
  function cekDateKey(v){
    const d = toDate(v);
    if (!d || isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }
  // Versi UTC: khusus untuk tanggal Data Gudang, yang selalu dibuat via Date.UTC(...)
  // (parseGudangSheet/dateInputToUTC). Memakai getter lokal (getFullYear/getMonth/getDate)
  // pada tanggal yang dikonstruksi UTC bisa menggeser tanggal/bulan di zona waktu tertentu —
  // fungsi ini memastikan pembacaannya konsisten dengan cara tanggal itu dibuat.
  function cekDateKeyUTC(v){
    const d = (v instanceof Date) ? v : toDate(v);
    if (!d || isNaN(d.getTime())) return '';
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth()+1).padStart(2,'0') + '-' + String(d.getUTCDate()).padStart(2,'0');
  }
  function monthKeyUTC(v){
    const d = (v instanceof Date) ? v : toDate(v);
    if (!d || isNaN(d.getTime())) return '';
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth()+1).padStart(2,'0');
  }
  function cekMonthKey(key){ return key ? key.slice(0,7) : ''; }

  /* Ambil data penjualan untuk tab Cek — INDEPENDENT dari filter tab Penjualan. */
  /* Cek: tarik data minimal dari Dexie (filter di query, bukan di memori) */
  async function fetchCekRawRows(month, opts){
    opts = opts || {};
    let dateFrom = opts.dateFrom || '';
    let dateTo = opts.dateTo || '';
    if (dateFrom && dateTo && dateFrom > dateTo) { const t = dateFrom; dateFrom = dateTo; dateTo = t; }
    const fromTs = dateStrToStartTs(dateFrom);
    const toTs = dateStrToEndTs(dateTo);
    const mode = opts.mode || ''; // 'fitri' | 'rupa' | ''

    let raw = [];
    if (useIDB && db){
      try {
        let coll;
        if (month) {
          coll = db.tx.where('bulan').equals(month);
        } else if (fromTs != null && toTs != null) {
          coll = db.tx.where('_ts').between(fromTs, toTs, true, true);
        } else if (fromTs != null) {
          coll = db.tx.where('_ts').aboveOrEqual(fromTs);
        } else if (toTs != null) {
          coll = db.tx.where('_ts').belowOrEqual(toTs);
        } else {
          coll = db.tx.toCollection();
        }
        // filter tambahan di IndexedDB (and) supaya data yang ditarik lebih sedikit
        coll = coll.and(r => {
          if (month && r.bulan !== month) return false;
          if (fromTs != null && (r._ts == null || r._ts < fromTs)) return false;
          if (toTs != null && (r._ts == null || r._ts > toTs)) return false;
          if (mode === 'fitri' && !isFitriProduct(r.produk)) return false;
          if (mode === 'rupa' && isFitriProduct(r.produk)) return false;
          return true;
        });
        raw = await coll.toArray();
      } catch(e){
        console.warn('fetchCekRawRows', e);
        raw = [];
      }
    } else {
      raw = rows.slice();
      if (month) raw = raw.filter(x => (x.bulan || '') === month);
      if (fromTs != null || toTs != null) {
        raw = raw.filter(x => rowInDateRange(x, fromTs, toTs));
      }
      if (mode === 'fitri') raw = raw.filter(x => isFitriProduct(x.produk));
      if (mode === 'rupa')  raw = raw.filter(x => !isFitriProduct(x.produk));
    }
    return raw || [];
  }

  function rowBulan(x){
    if (x.bulan) return x.bulan;
    const k = cekDateKey(x.Tanggal ?? x.tanggal);
    return k ? cekMonthKey(k) : '';
  }

  async function getCekSourceRows(month, opts){
    // Jangan materialise seluruh set — collectCekData bekerja langsung pada baris internal
    return await fetchCekRawRows(month, opts);
  }

  async function collectCekMonths(mode){
    const months = new Set();
    // prioritaskan meta months (tanpa scan seluruh transaksi)
    if (useIDB && db){
      try {
        const metaM = ((await db.meta.get('months')) || {}).value || [];
        metaM.forEach(m => { if (m) months.add(m); });
      } catch(e){}
    } else {
      rows.forEach(r => {
        const bl = r.bulan || rowBulan(r);
        if (bl) months.add(bl);
      });
    }
    if (gudangData && gudangData.rows){
      gudangData.rows.forEach(r => {
        const k = cekDateKeyUTC(r.tanggal);
        if (k) months.add(cekMonthKey(k));
      });
    }
    return [...months].filter(Boolean).sort().reverse();
  }

  let _cekFitriMonthInit = false;
  async function populateCekFitriMonths(){
    const sel = document.getElementById('cekFitriMonth');
    if (!sel) return;
    const arr = await collectCekMonths('fitri');
    const current = sel.value;
    sel.innerHTML = '<option value="">Semua bulan</option>' +
      arr.map(m => '<option value="' + m + '">' + monthLabel(m) + '</option>').join('');
    if (arr.includes(current)) sel.value = current;
    else if (current === '' && _cekFitriMonthInit) sel.value = '';
    else if (arr.length) sel.value = pickLatestMonth(arr);
    else sel.value = '';
    _cekFitriMonthInit = true;
  }

  // Nama singkat produk untuk tabel detail, mis. "FITRI BOTOL 400 ML" -> "Fitri400"
  function fitriShortName(name){
    const m = String(name ?? '').match(/(\d+)/);
    return m ? 'Fitri' + m[1] : String(name ?? '').trim();
  }

  // Label tanggal panjang ala "01-Agustus-26"
  function cekDateLabelLong(key){
    if (!key) return '';
    const [y,m,d] = key.split('-').map(Number);
    const dt = new Date(y, m-1, d);
    const bulan = dt.toLocaleDateString('id-ID', {month:'long'});
    return String(d).padStart(2,'0') + '-' + bulan + '-' + String(y).slice(-2);
  }

  /* selisih = PENJUALAN - OUTPUT GUDANG
     selisih === 0  -> Cocok
     selisih  > 0   -> OUTPUT GUDANG lebih sedikit (penjualan lebih banyak) -> normal, kemungkinan ada transaksi batal
     selisih  < 0   -> OUTPUT GUDANG lebih banyak -> perlu perhatian, tampilkan tanggal2 yg jadi penyebabnya bila ada */
  function ketBadge(selisih, dates){
    if (selisih === 0) {
      return '<span class="ket-badge ok">✅ Cocok</span>';
    }
    if (selisih > 0) {
      return '<span class="ket-badge warn" title="Normal, kemungkinan ada transaksi batal">🔷 Penjualan Lebih Banyak</span>';
    }
    const dTxt = (dates && dates.length) ? (' (' + dates.join(', ') + ')') : '';
    return '<span class="ket-badge alert">🚨 GUDANG LEBIH BANYAK!!' + dTxt + '</span>';
  }

  /* Versi teks polos dari ketBadge, dipakai untuk export xlsx */
  function ketText(selisih, dates){
    if (selisih === 0) return 'Cocok';
    if (selisih > 0) return 'Penjualan Lebih Banyak';
    return 'Gudang Lebih Banyak' + ((dates && dates.length) ? (' (' + dates.join(', ') + ')') : '');
  }

  /* Untuk baris rekap (per produk, gabungan banyak tanggal): cari daftar tanggal
     di mana OUTPUT GUDANG > PENJUALAN pada produk tsb, agar bisa ditampilkan di badge. */
  function ketGudangLebihDates(perDatePenjualan, perDateGudang){
    const pd = perDatePenjualan || {};
    const gd = perDateGudang || {};
    const keys = Array.from(new Set([...Object.keys(pd), ...Object.keys(gd)])).sort();
    const out = [];
    keys.forEach(k => {
      const p = N(pd[k]);
      const g = N(gd[k]);
      if (g > p) out.push(cekDateLabelLong(k));
    });
    return out;
  }

  /* mode: 'fitri' | 'rupa' — sourceRows = baris internal (hasil query Dexie yang sudah difilter)
     opts: { dateFrom, dateTo } — filter tanggal sudah diterapkan di fetch bila memungkinkan */
  function collectCekData(month, mode, sourceRows, opts){
    const src = sourceRows || [];
    opts = opts || {};
    let dateFrom = opts.dateFrom || '';
    let dateTo = opts.dateTo || '';
    if (dateFrom && dateTo && dateFrom > dateTo) { const t = dateFrom; dateFrom = dateTo; dateTo = t; }
    const hasDateRange = !!(dateFrom || dateTo);

    const isTarget = (p) => mode === 'fitri' ? isFitriProduct(p) : !isFitriProduct(p);
    const dateKeyInRange = (dk) => {
      if (!dk) return false;
      if (!hasDateRange) return true;
      if (dateFrom && dk < dateFrom) return false;
      if (dateTo && dk > dateTo) return false;
      return true;
    };

    // --- 1 pass penjualan: produk + sales + qty per sales + qty per tanggal ---
    const productMap = new Map();
    const salesTotals = new Map();
    const penjualanPS = {};
    const penjualanPD = {};

    for (let i = 0; i < src.length; i++) {
      const x = src[i];
      const produk = x.produk ?? x.Produk;
      if (!isTarget(produk)) continue;
      // filter bulan/tanggal cadangan (biasanya sudah di-query)
      if (month) {
        const bl = x.bulan || rowBulan(x);
        if (bl && bl !== month) continue;
      }
      if (hasDateRange) {
        const dk0 = cekDateKey(x.tanggal ?? x.Tanggal);
        if (dk0 && !dateKeyInRange(dk0)) continue;
        if (!dk0 && !rowInDateRange(x, dateStrToStartTs(dateFrom), dateStrToEndTs(dateTo))) continue;
      }
      const name = String(produk ?? '').trim();
      const pk = productMatchKey(name);
      if (!productMap.has(pk)) productMap.set(pk, name);

      const j = N(x.jumlah ?? x.Jumlah);
      const s = String(x.sales ?? x.Sales ?? '').trim() || '(Tanpa Sales)';
      salesTotals.set(s, (salesTotals.get(s) || 0) + j);

      if (!penjualanPS[pk]) penjualanPS[pk] = {};
      penjualanPS[pk][s] = (penjualanPS[pk][s] || 0) + j;

      const dk = cekDateKey(x.tanggal ?? x.Tanggal) || '';
      if (dk) {
        if (!penjualanPD[pk]) penjualanPD[pk] = {};
        penjualanPD[pk][dk] = (penjualanPD[pk][dk] || 0) + j;
      }
    }

    // --- gudang: map produk + 1 pass keluar ---
    const gudangProductByKey = {};
    if (gudangData && gudangData.products) {
      gudangData.products.forEach(p => {
        if (!isTarget(p)) return;
        gudangProductByKey[productMatchKey(p)] = p;
      });
    }
    const gudangPD = {};
    const gudangKeys = Object.keys(gudangProductByKey);
    if (gudangData && gudangData.rows && gudangKeys.length) {
      for (let i = 0; i < gudangData.rows.length; i++) {
        const r = gudangData.rows[i];
        const dk = cekDateKeyUTC(r.tanggal);
        if (!dk) continue;
        if (month && cekMonthKey(dk) !== month) continue;
        if (!dateKeyInRange(dk)) continue;
        for (let k = 0; k < gudangKeys.length; k++) {
          const key = gudangKeys[k];
          const colName = gudangProductByKey[key];
          const keluar = N((r.values[colName] || {}).keluar);
          if (!keluar) continue;
          if (!productMap.has(key)) productMap.set(key, colName);
          if (!gudangPD[key]) gudangPD[key] = {};
          gudangPD[key][dk] = (gudangPD[key][dk] || 0) + keluar;
        }
      }
    }

    const products = [...productMap.entries()]
      .map(([key, name]) => ({key, name}))
      .sort((a,b) => a.name.localeCompare(b.name, 'id'));
    products.forEach(p => {
      if (!penjualanPS[p.key]) penjualanPS[p.key] = {};
      if (!penjualanPD[p.key]) penjualanPD[p.key] = {};
      if (!gudangPD[p.key]) gudangPD[p.key] = {};
    });
    const salesList = [...salesTotals.entries()].sort((a,b) => b[1]-a[1]).map(([name]) => name);
    const hasGudang = !!(gudangData && gudangData.products && gudangData.products.length);
    return {products, salesList, penjualanPS, penjualanPD, gudangPD, hasGudang, mode, dateFrom, dateTo};
  }
  function collectCekFitriData(month, sourceRows, opts){ return collectCekData(month, 'fitri', sourceRows, opts); }

  let _cekLastData = null; // cache untuk tombol Download

  async function renderCekFitri(){
    await populateCekFitriMonths();
    const month = document.getElementById('cekFitriMonth')?.value || '';
    const bulanTxt = month ? monthLabel(month) : 'Semua Bulan';

    const dBulan = document.getElementById('cekDetailBulanLabel');
    if (dBulan) dBulan.textContent = bulanTxt;

    const sourceRows = await getCekSourceRows(month, { mode: 'fitri' });
    const data = collectCekFitriData(month, sourceRows, {});
    _cekLastData = data;
    const {products, salesList, penjualanPS, penjualanPD, gudangPD, hasGudang} = data;

    /* ============== KARTU 1: PENJUALAN FITRI (per Sales per Produk) ============== */
    const thead = document.getElementById('cekRingkasanThead');
    const tbody = document.getElementById('cekRingkasanTbody');
    const tfoot = document.getElementById('cekRingkasanTfoot');

    if (!products.length) {
      thead.innerHTML = '<tr><th>PRODUK</th><th>TOTAL</th><th>OUTPUT GUDANG</th><th>SELISIH</th><th>KET</th></tr>';
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:24px;color:#64748b">Belum ada data FITRI.</td></tr>';
      tfoot.innerHTML = '';
    } else {
      thead.innerHTML = '<tr><th>PRODUK</th>' +
        salesList.map(s => '<th>' + s + '</th>').join('') +
        '<th>TOTAL</th><th>OUTPUT GUDANG</th><th>SELISIH</th><th>KET</th></tr>';

      let rBody = '';
      const salesGrand = salesList.map(() => 0);
      let grandTotal = 0, grandGudang = 0, lebihSum = 0, kurangSum = 0, bedaAbsSum = 0;

      products.forEach(prod => {
        const perSales = penjualanPS[prod.key] || {};
        let rowTotal = 0;
        const cells = salesList.map((s, i) => {
          const v = N(perSales[s]);
          rowTotal += v;
          salesGrand[i] += v;
          return '<td class="num">' + nfQty(v) + '</td>';
        }).join('');
        const gTotal = Object.values(gudangPD[prod.key] || {}).reduce((a,b) => a+N(b), 0);
        const selisih = rowTotal - gTotal;
        const ok = selisih === 0;
        grandTotal += rowTotal; grandGudang += gTotal;
        bedaAbsSum += Math.abs(selisih);
        if (selisih > 0) kurangSum += selisih;   // penjualan > gudang => gudang KURANG
        if (selisih < 0) lebihSum += Math.abs(selisih); // gudang > penjualan => gudang LEBIH
        const gudangLebihDates = (hasGudang && selisih < 0) ? ketGudangLebihDates(penjualanPD[prod.key], gudangPD[prod.key]) : [];
        const selColor = ok ? '#166534' : (selisih > 0 ? '#1d4ed8' : '#dc2626');

        rBody += '<tr>' +
          '<td>' + prod.name + '</td>' +
          cells +
          '<td class="num" style="font-weight:800">' + nfQty(rowTotal) + '</td>' +
          '<td class="num">' + (hasGudang ? nfQty(gTotal) : '-') + '</td>' +
          '<td class="num" style="color:' + selColor + ';font-weight:700">' + (selisih > 0 ? '+' : '') + nfQty(selisih) + '</td>' +
          '<td>' + (hasGudang ? ketBadge(selisih, gudangLebihDates) : '-') + '</td>' +
        '</tr>';
      });

      tbody.innerHTML = rBody;

      const net = grandTotal - grandGudang;
      tfoot.innerHTML = '<tr>' +
        '<td>TOTAL</td>' +
        salesGrand.map(v => '<td class="num">' + nfQty(v) + '</td>').join('') +
        '<td class="num">' + nfQty(grandTotal) + '</td>' +
        '<td class="num">' + (hasGudang ? nfQty(grandGudang) : '-') + '</td>' +
        '<td class="num" style="color:' + (net === 0 ? '#166534' : '#b42318') + '">' + (net > 0 ? '+' : '') + nfQty(net) + '</td>' +
        '<td style="white-space:normal;color:#b45309;font-weight:700;font-size:11px">' +
          (hasGudang ? ('NET ' + nfQty(net) + ' · BEDA ABS ' + nfQty(bedaAbsSum) + ' (Gudang lebih ' + nfQty(lebihSum) + ' / kurang ' + nfQty(kurangSum) + ')') : '') +
        '</td>' +
      '</tr>';
    }

    /* ============== KARTU 2: DETAIL PER TANGGAL — FITRI ============== */
    const dtbody = document.getElementById('cekDetailTbody');
    if (!products.length) {
      dtbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:28px;color:#64748b">Belum ada data FITRI untuk dibandingkan.</td></tr>';
    } else {
      const allKeys = new Set();
      products.forEach(p => {
        Object.keys(penjualanPD[p.key] || {}).forEach(k => allKeys.add(k));
        Object.keys(gudangPD[p.key] || {}).forEach(k => allKeys.add(k));
      });
      const keys = [...allKeys].sort();

      if (!keys.length) {
        let msg = 'Belum ada data FITRI untuk dibandingkan.';
        if (!hasGudang) msg = 'Belum ada Data Gudang yang diupload.';
        dtbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:28px;color:#64748b">' + msg + '</td></tr>';
      } else {
        let dBody = '';
        keys.forEach(key => {
          products.forEach((prod, idx) => {
            const p = N((penjualanPD[prod.key] || {})[key]);
            const g = N((gudangPD[prod.key] || {})[key]);
            const s = p - g;
            const ok = s === 0;
            const sColor = ok ? '#166534' : (s > 0 ? '#1d4ed8' : '#dc2626');
            dBody += '<tr>' +
              (idx === 0 ? '<td class="tgl-cell" rowspan="' + products.length + '">' + cekDateLabelLong(key) + '</td>' : '') +
              '<td class="produk-cell"><div class="produk-short">' + fitriShortName(prod.name) + '</div><div class="produk-full">' + prod.name + '</div></td>' +
              '<td class="num">' + nfQty(p) + '</td>' +
              '<td class="num">' + (hasGudang ? nfQty(g) : '-') + '</td>' +
              '<td class="num" style="color:' + sColor + ';font-weight:700">' + (s > 0 ? '+' : '') + nfQty(s) + '</td>' +
              '<td>' + (hasGudang ? ketBadge(s) : '-') + '</td>' +
            '</tr>';
          });
        });
        dtbody.innerHTML = dBody;
      }
    }

  }

  function downloadCekRingkasan(){
    if (!_cekLastData || !_cekLastData.products.length) return alert('Belum ada data untuk diunduh.');
    const {products, salesList, penjualanPS, penjualanPD, gudangPD, hasGudang} = _cekLastData;
    const head = ['PRODUK', ...salesList, 'TOTAL', 'OUTPUT GUDANG', 'SELISIH', 'KET'];
    const salesGrand = salesList.map(() => 0);
    let grandTotal = 0, grandGudang = 0;
    const rows = products.map(prod => {
      const perSales = penjualanPS[prod.key] || {};
      let rowTotal = 0;
      const cells = salesList.map((s,i) => { const v = N(perSales[s]); rowTotal += v; salesGrand[i]+=v; return v; });
      const gTotal = Object.values(gudangPD[prod.key] || {}).reduce((a,b)=>a+N(b),0);
      grandTotal += rowTotal; grandGudang += gTotal;
      const selisih = rowTotal - gTotal;
      const gudangLebihDates = selisih < 0 ? ketGudangLebihDates(penjualanPD[prod.key], gudangPD[prod.key]) : [];
      return [prod.name, ...cells, rowTotal, hasGudang ? gTotal : '-', selisih, hasGudang ? ketText(selisih, gudangLebihDates) : '-'];
    });
    const foot = ['TOTAL', ...salesGrand, grandTotal, hasGudang?grandGudang:'-', grandTotal-grandGudang, ''];
    const ws = XLSX.utils.aoa_to_sheet([head, ...rows, foot]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Penjualan Fitri');
    XLSX.writeFile(wb, 'Penjualan_Fitri.xlsx');
  }

  function downloadCekDetail(){
    if (!_cekLastData || !_cekLastData.products.length) return alert('Belum ada data untuk diunduh.');
    const {products, penjualanPD, gudangPD, hasGudang} = _cekLastData;
    const allKeys = new Set();
    products.forEach(p => {
      Object.keys(penjualanPD[p.key] || {}).forEach(k => allKeys.add(k));
      Object.keys(gudangPD[p.key] || {}).forEach(k => allKeys.add(k));
    });
    const keys = [...allKeys].sort();
    const head = ['TANGGAL','PRODUK','PENJUALAN','OUTPUT GUDANG','SELISIH','KET'];
    const rows = [];
    keys.forEach(key => {
      products.forEach(prod => {
        const p = N((penjualanPD[prod.key] || {})[key]);
        const g = N((gudangPD[prod.key] || {})[key]);
        const s = p - g;
        rows.push([cekDateLabelLong(key), prod.name, p, hasGudang ? g : '-', s, hasGudang ? ketText(s) : '-']);
      });
    });
    const ws = XLSX.utils.aoa_to_sheet([head, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Detail Per Tanggal Fitri');
    XLSX.writeFile(wb, 'Detail_Per_Tanggal_Fitri.xlsx');
  }

  /* ------------- Cek sub-tab: Rupa Rupa ------------- */
  let _cekRupaLastData = null;
  let _cekRupaFilterKey = ''; // productMatchKey or '' for all

  function switchCekSub(which, btn){
    document.querySelectorAll('#page-cek .cek-subtab').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    const pf = document.getElementById('cekPanelFitri');
    const pr = document.getElementById('cekPanelRupa');
    if (pf) pf.classList.toggle('active', which === 'fitri');
    if (pr) pr.classList.toggle('active', which === 'rupa');
    if (which === 'fitri') renderCekFitri();
    else renderCekRupa();
  }

  let _cekRupaMonthInit = false;
  async function populateCekRupaMonths(){
    const sel = document.getElementById('cekRupaMonth');
    if (!sel) return;
    const arr = await collectCekMonths('rupa');
    const current = sel.value;
    sel.innerHTML = '<option value="">Semua bulan</option>' +
      arr.map(m => '<option value="' + m + '">' + monthLabel(m) + '</option>').join('');
    // Pertama kali buka: default bulan terkini. Setelah itu, '' = "Semua bulan" tetap dihormati.
    if (arr.includes(current)) sel.value = current;
    else if (current === '' && _cekRupaMonthInit) sel.value = '';
    else if (arr.length) sel.value = pickLatestMonth(arr);
    else sel.value = '';
    _cekRupaMonthInit = true;
  }

  async function resetCekRupaFilters(){
    _cekRupaMonthInit = true; // pastikan "Semua bulan" tidak diganti ke bulan terkini
    const monthSel = document.getElementById('cekRupaMonth');
    const df = document.getElementById('cekRupaDateFrom');
    const dt = document.getElementById('cekRupaDateTo');
    const search = document.getElementById('cekRupaSearch');
    const prod = document.getElementById('cekRupaProduct');
    const allBtn = document.getElementById('cekRupaAllBtn');
    if (monthSel) monthSel.value = '';
    if (df) df.value = '';
    if (dt) dt.value = '';
    if (search) search.value = '';
    if (prod) prod.value = '';
    _cekRupaFilterKey = '';
    if (allBtn) allBtn.classList.add('active');
    await renderCekRupa();
  }

  async function renderCekRupa(){
    await populateCekRupaMonths();
    const month = document.getElementById('cekRupaMonth')?.value || '';
    let dateFrom = document.getElementById('cekRupaDateFrom')?.value || '';
    let dateTo = document.getElementById('cekRupaDateTo')?.value || '';
    if (dateFrom && dateTo && dateFrom > dateTo) {
      const t = dateFrom; dateFrom = dateTo; dateTo = t;
      const a = document.getElementById('cekRupaDateFrom');
      const b = document.getElementById('cekRupaDateTo');
      if (a) a.value = dateFrom;
      if (b) b.value = dateTo;
    }
    const sourceRows = await getCekSourceRows(month, { mode: 'rupa', dateFrom, dateTo });
    _cekRupaLastData = collectCekData(month, 'rupa', sourceRows, { dateFrom, dateTo });
    // isi dropdown produk
    const sel = document.getElementById('cekRupaProduct');
    if (sel){
      const cur = _cekRupaFilterKey || sel.value;
      sel.innerHTML = '<option value="">— Pilih Produk —</option>' +
        _cekRupaLastData.products.map(p =>
          '<option value="' + p.key.replace(/"/g,'&quot;') + '">' + p.name + '</option>'
        ).join('');
      if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
      else sel.value = '';
    }
    renderCekRupaTable();
  }

  function onCekRupaProductPick(){
    const sel = document.getElementById('cekRupaProduct');
    _cekRupaFilterKey = (sel && sel.value) ? sel.value : '';
    const allBtn = document.getElementById('cekRupaAllBtn');
    if (allBtn) allBtn.classList.toggle('active', !_cekRupaFilterKey);
    const search = document.getElementById('cekRupaSearch');
    if (search && _cekRupaFilterKey) search.value = '';
    renderCekRupaTable();
  }

  function cekRupaShowAll(){
    _cekRupaFilterKey = '';
    const sel = document.getElementById('cekRupaProduct');
    if (sel) sel.value = '';
    const search = document.getElementById('cekRupaSearch');
    if (search) search.value = '';
    const allBtn = document.getElementById('cekRupaAllBtn');
    if (allBtn) allBtn.classList.add('active');
    renderCekRupaTable();
  }

  function nfQtyDash(v){
    const n = N(v);
    return n === 0 ? '—' : Math.round(n).toLocaleString('id-ID');
  }

  function renderCekRupaTable(){
    const thead = document.getElementById('cekRupaThead');
    const tbody = document.getElementById('cekRupaTbody');
    const tfoot = document.getElementById('cekRupaTfoot');
    if (!thead || !tbody || !tfoot) return;
    if (!_cekRupaLastData) {
      tbody.innerHTML = '<tr><td style="text-align:center;padding:24px;color:#64748b">Belum ada data.</td></tr>';
      thead.innerHTML = ''; tfoot.innerHTML = '';
      return;
    }
    const {products, salesList, penjualanPS, penjualanPD, gudangPD, hasGudang} = _cekRupaLastData;
    const q = (document.getElementById('cekRupaSearch')?.value || '').trim().toUpperCase();

    let list = products;
    if (_cekRupaFilterKey) list = list.filter(p => p.key === _cekRupaFilterKey);
    else if (q) list = list.filter(p => U(p.name).includes(q) || p.key.includes(productMatchKey(q)));

    if (!products.length) {
      thead.innerHTML = '<tr><th>PRODUK</th><th>TOTAL</th><th>OUTPUT GUDANG</th><th>SELISIH</th><th>KET</th></tr>';
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:24px;color:#64748b">Belum ada data Rupa Rupa.</td></tr>';
      tfoot.innerHTML = '';
      return;
    }

    thead.innerHTML = '<tr><th>PRODUK</th>' +
      salesList.map(s => '<th>' + s + '</th>').join('') +
      '<th>TOTAL</th><th>OUTPUT GUDANG</th><th>SELISIH</th><th>KET</th></tr>';

    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="' + (salesList.length + 5) + '" style="text-align:center;padding:24px;color:#64748b">Tidak ada produk yang cocok dengan filter.</td></tr>';
      tfoot.innerHTML = '';
      return;
    }

    let rBody = '';
    const salesGrand = salesList.map(() => 0);
    let grandTotal = 0, grandGudang = 0;

    list.forEach(prod => {
      const perSales = penjualanPS[prod.key] || {};
      let rowTotal = 0;
      const cells = salesList.map((s, i) => {
        const v = N(perSales[s]);
        rowTotal += v;
        salesGrand[i] += v;
        return '<td class="num">' + nfQtyDash(v) + '</td>';
      }).join('');
      const gTotal = Object.values(gudangPD[prod.key] || {}).reduce((a,b) => a+N(b), 0);
      const selisih = rowTotal - gTotal;
      const ok = selisih === 0;
      const hasGForProd = hasGudang && Object.keys(gudangPD[prod.key] || {}).length > 0;
      grandTotal += rowTotal; grandGudang += gTotal;
      const gudangLebihDates = (hasGForProd && selisih < 0) ? ketGudangLebihDates(penjualanPD[prod.key], gudangPD[prod.key]) : [];
      const selColor = ok ? '#166534' : (selisih > 0 ? '#1d4ed8' : '#dc2626');

      rBody += '<tr>' +
        '<td>' + prod.name + '</td>' +
        cells +
        '<td class="num" style="font-weight:800">' + nfQty(rowTotal) + '</td>' +
        '<td class="num">' + (hasGForProd ? nfQty(gTotal) : '—') + '</td>' +
        '<td class="num" style="color:' + selColor + ';font-weight:700">' +
          (hasGForProd ? ((selisih > 0 ? '+' : '') + nfQty(selisih)) : '—') + '</td>' +
        '<td>' + (hasGForProd ? ketBadge(selisih, gudangLebihDates) : '—') + '</td>' +
      '</tr>';
    });
    tbody.innerHTML = rBody;

    // Footer: jika filter satu produk / search, TOTAL mengikuti list terfilter
    const anyGudang = list.some(p => hasGudang && Object.keys(gudangPD[p.key] || {}).length > 0);
    const net = grandTotal - grandGudang;
    tfoot.innerHTML = '<tr>' +
      '<td>TOTAL</td>' +
      salesGrand.map(v => '<td class="num">' + nfQty(v) + '</td>').join('') +
      '<td class="num">' + nfQty(grandTotal) + '</td>' +
      '<td class="num">' + (anyGudang ? nfQty(grandGudang) : '—') + '</td>' +
      '<td class="num" style="color:' + (net === 0 ? '#166534' : '#b42318') + '">' +
        (anyGudang ? ((net > 0 ? '+' : '') + nfQty(net)) : '—') + '</td>' +
      '<td>—</td>' +
    '</tr>';
  }

  function downloadCekRupa(){
    if (!_cekRupaLastData || !_cekRupaLastData.products.length) return alert('Belum ada data untuk diunduh.');
    const {products, salesList, penjualanPS, penjualanPD, gudangPD, hasGudang} = _cekRupaLastData;
    const q = (document.getElementById('cekRupaSearch')?.value || '').trim().toUpperCase();
    let list = products;
    if (_cekRupaFilterKey) list = list.filter(p => p.key === _cekRupaFilterKey);
    else if (q) list = list.filter(p => U(p.name).includes(q) || p.key.includes(productMatchKey(q)));

    const head = ['PRODUK', ...salesList, 'TOTAL', 'OUTPUT GUDANG', 'SELISIH', 'KET'];
    const salesGrand = salesList.map(() => 0);
    let grandTotal = 0, grandGudang = 0;
    const rows = list.map(prod => {
      const perSales = penjualanPS[prod.key] || {};
      let rowTotal = 0;
      const cells = salesList.map((s,i) => { const v = N(perSales[s]); rowTotal += v; salesGrand[i]+=v; return v; });
      const gTotal = Object.values(gudangPD[prod.key] || {}).reduce((a,b)=>a+N(b),0);
      grandTotal += rowTotal; grandGudang += gTotal;
      const hasGForProd = hasGudang && Object.keys(gudangPD[prod.key] || {}).length > 0;
      const selisih = rowTotal - gTotal;
      const gudangLebihDates = (hasGForProd && selisih < 0) ? ketGudangLebihDates(penjualanPD[prod.key], gudangPD[prod.key]) : [];
      return [prod.name, ...cells, rowTotal, hasGForProd ? gTotal : '-', hasGForProd ? selisih : '-', hasGForProd ? ketText(selisih, gudangLebihDates) : '-'];
    });
    const foot = ['TOTAL', ...salesGrand, grandTotal, grandGudang || '-', grandTotal-grandGudang, ''];
    const ws = XLSX.utils.aoa_to_sheet([head, ...rows, foot]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Rupa Rupa');
    XLSX.writeFile(wb, 'Penjualan_Rupa_Rupa.xlsx');
  }

  function initMainTabs(){
    const nav = document.getElementById('mainTabs');
    if (!nav) return;
    nav.addEventListener('click', (e) => {
      const btn = e.target.closest('.main-tab');
      if (!btn) return;
      nav.querySelectorAll('.main-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      const pj = document.getElementById('page-penjualan');
      const gd = document.getElementById('page-gudang');
      const ck = document.getElementById('page-cek');
      if (pj) pj.style.display = (tab === 'penjualan') ? 'block' : 'none';
      if (gd) gd.style.display = (tab === 'gudang') ? 'block' : 'none';
      if (ck) ck.style.display = (tab === 'cek') ? 'block' : 'none';
      if (tab === 'cek') {
        const active = document.querySelector('#page-cek .cek-subtab.active');
        const which = active?.dataset?.cek || 'fitri';
        if (which === 'rupa') renderCekRupa();
        else renderCekFitri();
      }
    });
  }

  // Konversi serial tanggal Excel -> tanggal UTC murni (matematis, TIDAK terpengaruh
  // timezone perangkat sama sekali). 25569 = jumlah hari antara 30-12-1899 dan 1-1-1970.
  function excelSerialToUTCDate(serial){
    return new Date(Math.round((Number(serial) - 25569) * 86400000));
  }

  function parseGudangSheet(wb){
    const ws = wb.Sheets[wb.SheetNames[0]];
    const grid = XLSX.utils.sheet_to_json(ws, {header:1, defval:null, raw:true});
    if (!grid.length) return null;
    const headerRow = grid[0] || [];
    const products = [];
    for (let c = 1; c < headerRow.length; c += 3){
      const name = String(headerRow[c] ?? '').trim();
      if (name) products.push({name, col:c});
    }
    if (!products.length) return null;

    const saldoAwal = {};
    const dataRows = [];
    for (let r = 2; r < grid.length; r++){
      const row = grid[r] || [];
      const first = row[0];
      if (first == null || first === '') continue;
      if (typeof first === 'string' && first.trim().toLowerCase().startsWith('saldo awal')){
        products.forEach(p => { saldoAwal[p.name] = N(row[p.col+2]); });
        continue;
      }
      let dt = null;
      if (typeof first === 'number'){
        dt = excelSerialToUTCDate(first);
      } else if (first instanceof Date){
        // Fallback bila SheetJS tetap mengembalikan Date object: pakai bagian tanggalnya saja,
        // dibaca via komponen UTC agar tidak digeser oleh timezone lokal saat parsing.
        dt = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate()));
      } else {
        const s = String(first).trim();
        const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/); // dd/mm/yyyy atau dd-mm-yyyy
        if (m){
          let yy = +m[3]; if (yy < 100) yy += 2000;
          dt = new Date(Date.UTC(yy, +m[2]-1, +m[1]));
        } else {
          const parsed = new Date(s + 'T00:00:00Z');
          if (!isNaN(parsed.getTime())) dt = parsed;
        }
      }
      if (!dt || isNaN(dt.getTime())) continue;
      const values = {};
      products.forEach(p => {
        values[p.name] = {
          masuk:  row[p.col]   === null || row[p.col]   === '' ? null : N(row[p.col]),
          keluar: row[p.col+1] === null || row[p.col+1] === '' ? null : N(row[p.col+1]),
          stok:   row[p.col+2] === null || row[p.col+2] === '' ? null : N(row[p.col+2])
        };
      });
      dataRows.push({ts: dt.getTime(), tanggal: dt, values});
    }
    dataRows.sort((a,b) => a.ts - b.ts);

    // STOK SFA dihitung otomatis (running balance) agar selalu ikut bertambah/berkurang
    // saat ada MASUK/KELUAR, walau sel Stok di Excel belum diisi manual.
    products.forEach(p => {
      let running = N(saldoAwal[p.name]);
      dataRows.forEach(r => {
        const v = r.values[p.name];
        running = running + N(v.masuk) - N(v.keluar);
        v.stok = running;
      });
    });

    return {products: products.map(p => p.name), saldoAwal, rows: dataRows};
  }

  /* Gabungkan data gudang baru dengan yang sudah tersimpan, per tanggal & produk,
     supaya upload bulan berikutnya tidak menghapus bulan sebelumnya.
     Jika ada tanggal yang sama di kedua data, baris dari file yang baru diupload
     yang dipakai (dianggap koreksi/update terbaru). */
  function mergeGudangData(existing, incoming){
    if (!existing || !existing.rows || !existing.rows.length) return incoming;

    const products = Array.from(new Set([...(existing.products||[]), ...(incoming.products||[])]));

    // Saldo awal: pertahankan punya data lama untuk produk yang sudah ada HANYA kalau file
    // baru ini murni lanjutan ke depan (tanggal paling awal di file baru > tanggal paling awal
    // yang sudah tersimpan). Kalau file baru mencakup/menimpa tanggal paling awal yang sudah
    // ada (mis. re-upload seluruh sheet karena Saldo Awal-nya dikoreksi), Saldo Awal dari file
    // baru dipakai — bukan dibuang diam-diam. Produk yang benar-benar baru selalu pakai saldo
    // awal dari file baru.
    const existingMinTs = existing.rows.length ? Math.min(...existing.rows.map(r => r.ts)) : Infinity;
    const incomingMinTs = (incoming.rows||[]).length ? Math.min(...incoming.rows.map(r => r.ts)) : Infinity;
    const incomingIsCorrection = incomingMinTs <= existingMinTs;

    const saldoAwal = {};
    products.forEach(p => {
      const hasOld = Object.prototype.hasOwnProperty.call(existing.saldoAwal||{}, p);
      const hasNew = Object.prototype.hasOwnProperty.call(incoming.saldoAwal||{}, p);
      if (hasOld && !(incomingIsCorrection && hasNew)) saldoAwal[p] = existing.saldoAwal[p];
      else saldoAwal[p] = (incoming.saldoAwal||{})[p] ?? (hasOld ? existing.saldoAwal[p] : 0);
    });

    // Gabungkan baris berdasarkan ts (tanggal). Baris dari incoming menang jika bentrok.
    const byTs = new Map();
    existing.rows.forEach(r => byTs.set(r.ts, {ts:r.ts, tanggal:r.tanggal, values:{...r.values}}));
    incoming.rows.forEach(r => {
      const cur = byTs.get(r.ts);
      if (!cur) { byTs.set(r.ts, {ts:r.ts, tanggal:r.tanggal, values:{...r.values}}); return; }
      // merge per produk: field dari incoming dipakai kalau ada isinya, kalau tidak pertahankan yang lama
      const mergedValues = {...cur.values};
      products.forEach(p => {
        const inV = r.values[p];
        if (inV) mergedValues[p] = inV; // file baru menang untuk produk yang disebut di file baru
      });
      byTs.set(r.ts, {ts:r.ts, tanggal:r.tanggal, values:mergedValues});
    });

    const mergedRows = [...byTs.values()].sort((a,b) => a.ts - b.ts);

    // Hitung ulang STOK SFA (running balance) dari saldo awal untuk semua produk gabungan
    products.forEach(p => {
      let running = N(saldoAwal[p]);
      mergedRows.forEach(r => {
        if (!r.values[p]) r.values[p] = {masuk:null, keluar:null, stok:null};
        const v = r.values[p];
        running = running + N(v.masuk) - N(v.keluar);
        v.stok = running;
      });
    });

    return {products, saldoAwal, rows: mergedRows};
  }

  async function processGudangFile(){
    const inp = document.getElementById('gudangFile');
    const file = inp && inp.files && inp.files[0];
    if (!file) return alert('Pilih file Excel gudang terlebih dahulu.');
    setGudangStatus('Memproses file...');
    try{
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, {type:'array'});
      const parsed = parseGudangSheet(wb);
      if (!parsed) { setGudangStatus('Format file tidak dikenali. Pastikan mengikuti template stok gudang.'); return; }
      const merged = mergeGudangData(gudangData, parsed);
      gudangData = merged;
      await saveGudangToDB(merged);
      renderGudangPage(merged);
      renderCekFitri();
      setGudangStatus('Berhasil memproses ' + parsed.rows.length.toLocaleString('id-ID') + ' baris baru. Total tersimpan: ' + merged.rows.length.toLocaleString('id-ID') + ' baris tanggal, ' + merged.products.length + ' produk.');
      inp.value = '';
      closeGudangDd();
    } catch(e){
      console.error(e);
      setGudangStatus('Gagal memproses file: ' + e.message);
    }
  }

  function setGudangStatus(msg){
    const el = document.getElementById('gudangStatus');
    if (el) el.textContent = msg;
  }

  async function clearGudangData(){
    if (!confirm('Hapus SEMUA data gudang dari SEMUA bulan yang tersimpan? Tindakan ini tidak bisa dibatalkan.')) return;
    gudangData = null;
    if (useIDB){ try{ await db.meta.delete('gudangData'); } catch(e){} }
    renderGudangPage(null);
    renderCekFitri();
    setGudangStatus('Data gudang sudah dihapus.');
    closeGudangDd();
    schedulePush();
  }

  /* Hitung ulang STOK SFA (running balance) semua produk dari saldoAwal,
     dipakai setelah baris dihapus/diubah supaya stok tetap berkesinambungan. */
  function recomputeGudangStok(data){
    if (!data || !data.rows) return data;
    (data.products||[]).forEach(p => {
      let running = N((data.saldoAwal||{})[p]);
      data.rows.forEach(r => {
        if (!r.values[p]) r.values[p] = {masuk:null, keluar:null, stok:null};
        const v = r.values[p];
        running = running + N(v.masuk) - N(v.keluar);
        v.stok = running;
      });
    });
    return data;
  }

  function populateGudangDeleteMonth(){
    const sel = document.getElementById('gudangDeleteMonth');
    if (!sel) return;
    const cur = sel.value;
    if (!gudangData || !gudangData.rows || !gudangData.rows.length){
      sel.innerHTML = '<option value="">Belum ada data</option>';
      return;
    }
    const monthKeys = [...new Set(gudangData.rows.map(r => monthKeyUTC(r.tanggal)).filter(Boolean))].sort().reverse();
    sel.innerHTML = '<option value="">Pilih bulan…</option>' +
      monthKeys.map(m => '<option value="' + m + '">' + monthLabel(m) + '</option>').join('');
    if (monthKeys.includes(cur)) sel.value = cur;
  }

  async function deleteGudangMonth(){
    const sel = document.getElementById('gudangDeleteMonth');
    const month = sel && sel.value;
    if (!month) return alert('Pilih bulan yang mau dihapus terlebih dahulu.');
    if (!gudangData || !gudangData.rows || !gudangData.rows.length) return;
    if (!confirm('Hapus data gudang bulan ' + monthLabel(month) + ' saja? Bulan lain tidak akan terpengaruh. Tindakan ini tidak bisa dibatalkan.')) return;
    gudangData.rows = gudangData.rows.filter(r => monthKeyUTC(r.tanggal) !== month);
    recomputeGudangStok(gudangData);
    if (!gudangData.rows.length) gudangData = null;
    if (useIDB){
      try{
        if (gudangData) await db.meta.put({key:'gudangData', value:gudangData});
        else await db.meta.delete('gudangData');
      } catch(e){ console.warn('save gudang', e); }
    }
    renderGudangPage(gudangData);
    populateGudangDeleteMonth();
    renderCekFitri();
    setGudangStatus('Data gudang bulan ' + monthLabel(month) + ' sudah dihapus.');
    schedulePush();
  }

  async function saveGudangToDB(data){
    if (useIDB){ try{ await db.meta.put({key:'gudangData', value:data}); } catch(e){ console.warn('save gudang', e); } }
    schedulePush();
  }

  async function loadGudangFromDB(){
    if (useIDB){
      try{
        const rec = await db.meta.get('gudangData');
        if (rec && rec.value){
          gudangData = rec.value;
          gudangData.rows.forEach(r => { r.tanggal = new Date(r.ts); });
        }
      } catch(e){ console.warn('load gudang', e); }
    }
    renderGudangPage(gudangData);
    renderCekFitri();
  }

  /* Sub-tab Data Gudang: 'fitri' | 'rupa' */
  let _gudangSub = 'fitri';

  function switchGudangSub(which, btn){
    _gudangSub = (which === 'rupa') ? 'rupa' : (which === 'analisa') ? 'analisa' : 'fitri';
    document.querySelectorAll('#page-gudang .gudang-subtab').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    else {
      const match = document.querySelector('#page-gudang .gudang-subtab[data-gudang="' + _gudangSub + '"]');
      if (match) match.classList.add('active');
    }
    renderGudangPage(gudangData);
  }

  function renderGudangPage(data){
    const kpiBox = document.getElementById('gudangKpis');
    const thead  = document.getElementById('gudangThead');
    const tbody  = document.getElementById('gudangTbody');
    if (!thead || !tbody) return;

    // Sub-tab "Analisa": tampilan & sumber data berbeda dari Fitri/Rupa Rupa (ledger gudang).
    const normalCard  = document.getElementById('gudangNormalCard');
    const analisaCard = document.getElementById('gudangAnalisaCard');
    if (_gudangSub === 'analisa'){
      if (normalCard)  normalCard.style.display  = 'none';
      if (analisaCard) analisaCard.style.display = '';
      if (kpiBox) kpiBox.innerHTML = '';
      renderGudangAnalisa();
      return;
    }
    if (normalCard)  normalCard.style.display  = '';
    if (analisaCard) analisaCard.style.display = 'none';

    if (!data || !data.products || !data.products.length){
      kpiBox.innerHTML = '<div style="padding:10px 4px;color:#64748b;font-size:13px;align-self:center">Belum ada data gudang. Klik ⚙️ di kanan untuk upload file Excel.</div>';
      thead.innerHTML = '';
      tbody.innerHTML = '<tr><td style="text-align:center;padding:24px;color:#64748b">Belum ada data. Klik ⚙️ di atas untuk upload file Excel.</td></tr>';
      populateGudangDeleteMonth();
      return;
    }

    const {saldoAwal, rows} = data;
    // Filter produk sesuai sub-tab Fitri / Rupa Rupa
    const products = (data.products || []).filter(p =>
      _gudangSub === 'fitri' ? isFitriProduct(p) : !isFitriProduct(p)
    );

    // Populate month filter dropdown (keep current selection if still valid)
    const monthSel = document.getElementById('gudangMonth');
    let selMonth = monthSel ? monthSel.value : '';
    const monthKeys = [...new Set(rows.map(r => monthKeyUTC(r.tanggal)).filter(Boolean))].sort().reverse();
    if (monthSel){
      monthSel.innerHTML = '<option value="">Semua bulan</option>' +
        monthKeys.map(m => '<option value="' + m + '">' + monthLabel(m) + '</option>').join('');
      if (monthKeys.includes(selMonth)) {
        monthSel.value = selMonth;
      } else if (monthKeys.length) {
        // pertama dibuka / pilihan lama tidak valid → bulan terkini
        selMonth = pickLatestMonth(monthKeys);
        monthSel.value = selMonth;
      } else {
        selMonth = '';
      }
    }

    // Filter rows by selected month
    const rowsFiltered = selMonth ? rows.filter(r => monthKeyUTC(r.tanggal) === selMonth) : rows;

    // Saldo awal untuk ditampilkan: kalau difilter ke satu bulan, pakai stok terakhir
    // sebelum bulan tsb (per produk), bukan saldo awal keseluruhan data.
    let displaySaldoAwal = saldoAwal;
    if (selMonth){
      displaySaldoAwal = {};
      products.forEach(p => {
        let last = saldoAwal[p] ?? 0;
        for (let i = 0; i < rows.length; i++){
          if (monthKeyUTC(rows[i].tanggal) === selMonth) break;
          if (rows[i].values[p] && rows[i].values[p].stok !== null) last = rows[i].values[p].stok;
        }
        displaySaldoAwal[p] = last;
      });
    }

    if (!products.length){
      const label = _gudangSub === 'fitri' ? 'Fitri' : 'Rupa Rupa';
      kpiBox.innerHTML = '<div style="padding:10px 4px;color:#64748b;font-size:13px;align-self:center">Tidak ada produk ' + label + ' di Data Gudang.</div>';
      thead.innerHTML = '';
      tbody.innerHTML = '<tr><td style="text-align:center;padding:24px;color:#64748b">Tidak ada produk ' + label + '. Coba sub-tab lain atau upload file yang memuat produk tersebut.</td></tr>';
      return;
    }

    // KPI cards: stok akhir per produk (mengikuti filter bulan + sub-tab) — klik kartu untuk input Masuk/Keluar
    kpiBox.innerHTML = products.map(p => {
      let last = displaySaldoAwal[p] ?? 0;
      for (let i = rowsFiltered.length - 1; i >= 0; i--){ if (rowsFiltered[i].values[p] && rowsFiltered[i].values[p].stok !== null){ last = rowsFiltered[i].values[p].stok; break; } }
      const totMasuk  = rowsFiltered.reduce((s,r) => s + N(r.values[p] && r.values[p].masuk), 0);
      const totKeluar = rowsFiltered.reduce((s,r) => s + N(r.values[p] && r.values[p].keluar), 0);
      return '<div class="gkpi" onclick="openGInputModal(\'' + escJsAttr(p) + '\')" title="Klik untuk input Masuk / Keluar">' +
             '<span class="gk-label">' + escHtml(p) + '</span>' +
             '<span class="gk-stok">Stok: ' + nfQty(last) + '</span>' +
             '<span class="gk-meta">Masuk <b>' + nfQty(totMasuk) + '</b> &nbsp;•&nbsp; Keluar <b>' + nfQty(totKeluar) + '</b></span>' +
             '<span class="gk-hint">✏️ klik untuk input</span>' +
             '</div>';
    }).join('');

    // Header (2 rows)
    thead.innerHTML =
      '<tr><th rowspan="2">TANGGAL</th>' + products.map(p => '<th colspan="3">' + escHtml(p) + '</th>').join('') + '</tr>' +
      '<tr>' + products.map(() => '<th>MASUK</th><th>KELUAR</th><th>STOK SFA</th>').join('') + '</tr>';

    // Body
    let body = '<tr class="gudang-saldo-row"><td>Saldo Awal</td>' +
      products.map(p => '<td class="num">-</td><td class="num">-</td><td class="num">' + nfQty(displaySaldoAwal[p]) + '</td>').join('') + '</tr>';
    body += rowsFiltered.map(r => {
      return '<tr><td>' + gudangFmtDate(r.tanggal) + '</td>' + products.map(p => {
        const v = r.values[p] || {};
        return '<td class="num">' + nfQty(v.masuk) + '</td><td class="num">' + nfQty(v.keluar) + '</td><td class="num">' + nfQty(v.stok) + '</td>';
      }).join('') + '</tr>';
    }).join('');
    tbody.innerHTML = body;
    populateGudangDeleteMonth();
  }

  /* ------------- Sub-tab "Analisa": Penjualan vs Gudang vs Profit vs Stok (khusus FITRI) ------------- */

  // Stok akhir saat ini (paling mutakhir) untuk 1 produk gudang, tidak terikat filter bulan —
  // dipakai sebagai "snapshot" kondisi stok terkini, terlepas dari periode yang sedang dilihat.
  function gudangStokAkhirNow(product){
    if (!gudangData) return 0;
    let last = N((gudangData.saldoAwal || {})[product]);
    (gudangData.rows || []).forEach(r => {
      const v = r.values[product];
      if (v && v.stok !== null && v.stok !== undefined) last = v.stok;
    });
    return last;
  }

  // Harga Beli paling akhir (terbaru) per produk FITRI, diambil dari SELURUH data penjualan
  // (tanpa filter bulan) — supaya nilai stok selalu dihargai dengan harga beli paling mutakhir.
  async function gudangHargaBeliTerbaruMap(){
    const allRows = await getCekSourceRows('', {mode:'fitri'});
    const latest = {};
    allRows.forEach(x => {
      const produk = String(x.produk ?? x.Produk ?? '').trim();
      if (!produk) return;
      const hb = N(x.hargaBeli ?? x['Harga Beli']);
      if (hb <= 0) return;
      const ts = x._ts || 0;
      const key = productMatchKey(produk);
      if (!latest[key] || ts >= latest[key].ts) latest[key] = {ts, hb};
    });
    return latest;
  }

  // Kumpulkan data Analisa (per produk FITRI) untuk bulan terpilih (''=semua bulan):
  // OUTPUT PENJUALAN & TOTAL PENJUALAN & HPP & PROFIT mengikuti filter bulan;
  // OUTPUT GUDANG (keluar) mengikuti filter bulan yang sama;
  // STOK AKHIR & HARGA BELI TERBARU adalah kondisi terkini (tidak difilter bulan).
  async function collectGudangAnalisaData(month){
    const sourceRows = await getCekSourceRows(month, {mode:'fitri'});
    const productMap = new Map();      // key -> nama produk
    const penjualanQty = {}, penjualanTotal = {}, penjualanHpp = {};

    sourceRows.forEach(x => {
      const produk = String(x.produk ?? x.Produk ?? '').trim();
      if (!produk) return;
      const key = productMatchKey(produk);
      if (!productMap.has(key)) productMap.set(key, produk);
      const j = N(x.jumlah ?? x.Jumlah);
      const t = N(x.total ?? x.Total);
      const hb = N(x.hargaBeli ?? x['Harga Beli']);
      penjualanQty[key]   = (penjualanQty[key]   || 0) + j;
      penjualanTotal[key] = (penjualanTotal[key] || 0) + t;
      penjualanHpp[key]   = (penjualanHpp[key]   || 0) + j * hb;
    });

    // Peta key(nama dinormalisasi) -> nama kolom ASLI di Data Gudang. Nama produk di Penjualan
    // dan di Data Gudang bisa beda penulisan (mis. "FITRI BOTOL 400ML" vs "FITRI BOTOL 400 ML"),
    // jadi pencarian stok HARUS lewat key ini, bukan nama dari data Penjualan.
    const gudangColByKey = {};
    if (gudangData && gudangData.products){
      gudangData.products.filter(isFitriProduct).forEach(p => {
        const key = productMatchKey(p);
        gudangColByKey[key] = p;
        if (!productMap.has(key)) productMap.set(key, p);
      });
    }

    // Output Gudang (Keluar) per produk, mengikuti filter bulan.
    const gudangKeluar = {};
    if (gudangData && gudangData.rows){
      gudangData.rows.forEach(r => {
        const dk = cekDateKeyUTC(r.tanggal);
        if (month && cekMonthKey(dk) !== month) return;
        Object.keys(r.values || {}).forEach(p => {
          if (!isFitriProduct(p)) return;
          const keluar = N((r.values[p] || {}).keluar);
          if (!keluar) return;
          const key = productMatchKey(p);
          if (!productMap.has(key)) productMap.set(key, p);
          gudangKeluar[key] = (gudangKeluar[key] || 0) + keluar;
        });
      });
    }

    const hbTerbaruMap = await gudangHargaBeliTerbaruMap();

    const products = [...productMap.entries()]
      .map(([key, name]) => ({key, name}))
      .sort((a,b) => a.name.localeCompare(b.name, 'id'));

    const list = products.map(p => {
      const outputPenjualan = N(penjualanQty[p.key]);
      const outputGudang    = N(gudangKeluar[p.key]);
      const totalPenjualan  = N(penjualanTotal[p.key]);
      const hpp             = N(penjualanHpp[p.key]);
      const profitPenjualan = totalPenjualan - hpp;
      const gudangColName   = gudangColByKey[p.key];
      const stokAkhir       = gudangColName ? gudangStokAkhirNow(gudangColName) : 0;
      const hargaBeliTerbaru = (hbTerbaruMap[p.key] || {}).hb || 0;
      const nominalStokAkhir = stokAkhir * hargaBeliTerbaru;
      return {name:p.name, outputPenjualan, outputGudang, totalPenjualan, hpp, profitPenjualan, stokAkhir, hargaBeliTerbaru, nominalStokAkhir};
    });

    const hasGudang = !!(gudangData && gudangData.products && gudangData.products.length);
    return {list, hasGudang};
  }

  let _gudangAnalisaLast = null;

  async function renderGudangAnalisa(){
    const thead = document.getElementById('gudangAnalisaThead');
    const tbody = document.getElementById('gudangAnalisaTbody');
    const tfoot = document.getElementById('gudangAnalisaTfoot');
    const kpiBox = document.getElementById('gudangKpis');
    if (!thead || !tbody) return;

    // Dropdown bulan dipakai bersama lintas sub-tab Fitri/Rupa Rupa/Analisa; isi ulang dari data gudang.
    const monthSel = document.getElementById('gudangMonth');
    let selMonth = monthSel ? monthSel.value : '';
    if (monthSel){
      const rowsAll = (gudangData && gudangData.rows) || [];
      const curr = monthSel.value;
      const monthKeys = [...new Set(rowsAll.map(r => monthKeyUTC(r.tanggal)).filter(Boolean))].sort().reverse();
      monthSel.innerHTML = '<option value="">Semua bulan</option>' +
        monthKeys.map(m => '<option value="' + m + '">' + monthLabel(m) + '</option>').join('');
      if (monthKeys.includes(curr)) { monthSel.value = curr; selMonth = curr; }
      else if (monthKeys.length) { selMonth = pickLatestMonth(monthKeys); monthSel.value = selMonth; }
      else { selMonth = ''; monthSel.value = ''; }
    }
    populateGudangDeleteMonth();

    const data = await collectGudangAnalisaData(selMonth);
    _gudangAnalisaLast = data;
    const {list, hasGudang} = data;

    if (kpiBox){
      if (!list.length){
        kpiBox.innerHTML = '';
      } else {
        const totalProfit = list.reduce((a,r) => a + r.profitPenjualan, 0);
        const totalNominalStok = list.reduce((a,r) => a + r.nominalStokAkhir, 0);
        kpiBox.innerHTML =
          '<div class="gkpi" style="cursor:default">' +
            '<span class="gk-label">TOTAL PROFIT PENJUALAN FITRI</span>' +
            '<span class="gk-stok" style="color:' + (totalProfit >= 0 ? '#166534' : '#dc2626') + '">' + rp(totalProfit) + '</span>' +
          '</div>' +
          '<div class="gkpi" style="cursor:default">' +
            '<span class="gk-label">TOTAL NOMINAL STOK AKHIR</span>' +
            '<span class="gk-stok">' + rp(totalNominalStok) + '</span>' +
          '</div>';
      }
    }

    thead.innerHTML = '<tr>' +
      '<th>PRODUK FITRI</th><th>OUTPUT PENJUALAN</th><th>OUTPUT GUDANG</th><th>KET</th>' +
      '<th>TOTAL PENJUALAN</th><th>HPP</th><th>PROFIT PENJUALAN</th><th>STOK AKHIR</th>' +
      '<th>HARGA BELI TERBARU</th><th>NOMINAL STOK AKHIR</th>' +
    '</tr>';

    if (!list.length){
      tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:24px;color:#64748b">Belum ada data penjualan/gudang FITRI untuk dianalisa.</td></tr>';
      tfoot.innerHTML = '';
      return;
    }

    let sumOP=0, sumOG=0, sumTP=0, sumHPP=0, sumProfit=0, sumStok=0, sumNominal=0;
    let body = '';
    list.forEach(r => {
      sumOP += r.outputPenjualan; sumOG += r.outputGudang; sumTP += r.totalPenjualan;
      sumHPP += r.hpp; sumProfit += r.profitPenjualan; sumStok += r.stokAkhir; sumNominal += r.nominalStokAkhir;
      const selisih = r.outputPenjualan - r.outputGudang;
      body += '<tr>' +
        '<td>' + escHtml(r.name) + '</td>' +
        '<td class="num">' + nfQty(r.outputPenjualan) + '</td>' +
        '<td class="num">' + (hasGudang ? nfQty(r.outputGudang) : '-') + '</td>' +
        '<td>' + (hasGudang ? ketBadge(selisih) : '-') + '</td>' +
        '<td class="num">' + rp(r.totalPenjualan) + '</td>' +
        '<td class="num">' + rp(r.hpp) + '</td>' +
        '<td class="num" style="font-weight:700;color:' + (r.profitPenjualan >= 0 ? '#166534' : '#dc2626') + '">' + rp(r.profitPenjualan) + '</td>' +
        '<td class="num">' + nfQty(r.stokAkhir) + '</td>' +
        '<td class="num">' + rp(r.hargaBeliTerbaru) + '</td>' +
        '<td class="num" style="font-weight:700">' + rp(r.nominalStokAkhir) + '</td>' +
      '</tr>';
    });
    tbody.innerHTML = body;

    const netSel = sumOP - sumOG;
    tfoot.innerHTML = '<tr>' +
      '<td>TOTAL</td>' +
      '<td class="num">' + nfQty(sumOP) + '</td>' +
      '<td class="num">' + (hasGudang ? nfQty(sumOG) : '-') + '</td>' +
      '<td>' + (hasGudang ? ketBadge(netSel) : '') + '</td>' +
      '<td class="num">' + rp(sumTP) + '</td>' +
      '<td class="num">' + rp(sumHPP) + '</td>' +
      '<td class="num" style="font-weight:800">' + rp(sumProfit) + '</td>' +
      '<td class="num">' + nfQty(sumStok) + '</td>' +
      '<td class="num">-</td>' +
      '<td class="num" style="font-weight:800">' + rp(sumNominal) + '</td>' +
    '</tr>';
  }

  function downloadGudangAnalisa(){
    if (!_gudangAnalisaLast || !_gudangAnalisaLast.list.length) return alert('Belum ada data untuk diunduh.');
    const {list, hasGudang} = _gudangAnalisaLast;
    const head = ['PRODUK FITRI','OUTPUT PENJUALAN','OUTPUT GUDANG','KET','TOTAL PENJUALAN','HPP','PROFIT PENJUALAN','STOK AKHIR','HARGA BELI TERBARU','NOMINAL STOK AKHIR'];
    let sumOP=0, sumOG=0, sumTP=0, sumHPP=0, sumProfit=0, sumStok=0, sumNominal=0;
    const dataRows = list.map(r => {
      sumOP += r.outputPenjualan; sumOG += r.outputGudang; sumTP += r.totalPenjualan;
      sumHPP += r.hpp; sumProfit += r.profitPenjualan; sumStok += r.stokAkhir; sumNominal += r.nominalStokAkhir;
      const selisih = r.outputPenjualan - r.outputGudang;
      return [r.name, r.outputPenjualan, hasGudang ? r.outputGudang : '-', hasGudang ? ketText(selisih) : '-',
        r.totalPenjualan, r.hpp, r.profitPenjualan, r.stokAkhir, r.hargaBeliTerbaru, r.nominalStokAkhir];
    });
    const foot = ['TOTAL', sumOP, hasGudang ? sumOG : '-', '', sumTP, sumHPP, sumProfit, sumStok, '', sumNominal];
    const ws = XLSX.utils.aoa_to_sheet([head, ...dataRows, foot]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Analisa Fitri');
    XLSX.writeFile(wb, 'Analisa_Fitri.xlsx');
  }

  /* ------------- Modal Input Stok Gudang (klik kartu produk) ------------- */
  let gInputState = null; // {product}

  function dateInputToUTC(dateStr){
    if (!dateStr) return null;
    const [y,m,d] = dateStr.split('-').map(Number);
    if (!y || !m || !d) return null;
    return new Date(Date.UTC(y, m-1, d));
  }
  function utcDateToInputStr(d){
    if (!d || isNaN(d.getTime())) return '';
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth()+1).padStart(2,'0') + '-' + String(d.getUTCDate()).padStart(2,'0');
  }
  function todayInputStr(){
    const n = new Date();
    return n.getFullYear() + '-' + String(n.getMonth()+1).padStart(2,'0') + '-' + String(n.getDate()).padStart(2,'0');
  }
  // Stok sebelum tanggal tertentu (saldo awal + akumulasi masuk/keluar sebelum ts), TIDAK termasuk baris ts itu sendiri.
  function gStokSebelum(product, ts){
    if (!gudangData) return 0;
    let running = N((gudangData.saldoAwal || {})[product]);
    (gudangData.rows || []).forEach(r => {
      if (r.ts < ts){
        const v = r.values[product];
        if (v) running += N(v.masuk) - N(v.keluar);
      }
    });
    return running;
  }

  function openGInputModal(product){
    if (!gudangData || !gudangData.products || !gudangData.products.length){
      alert('Belum ada Data Gudang. Upload file Excel gudang terlebih dahulu lewat ⚙️.');
      return;
    }
    gInputState = {product};
    document.getElementById('gInputProdName').textContent = product;
    // Default tanggal: bulan yang sedang difilter (kalau ada & bukan bulan berjalan) pakai tanggal terakhir data bulan itu, selain itu pakai hari ini.
    const monthSel = document.getElementById('gudangMonth');
    const selMonth = monthSel ? monthSel.value : '';
    let dateStr = todayInputStr();
    if (selMonth && selMonth !== monthKey(new Date())){
      const rowsInMonth = (gudangData.rows || []).filter(r => monthKeyUTC(r.tanggal) === selMonth);
      if (rowsInMonth.length) dateStr = utcDateToInputStr(rowsInMonth[rowsInMonth.length - 1].tanggal);
      else { const [y,m] = selMonth.split('-').map(Number); dateStr = y + '-' + String(m).padStart(2,'0') + '-01'; }
    }
    document.getElementById('gInputDate').value = dateStr;
    fillGInputFromDate();
    document.getElementById('gInputOverlay').classList.add('show');
  }
  function closeGInputModal(){
    document.getElementById('gInputOverlay').classList.remove('show');
    gInputState = null;
  }
  function fillGInputFromDate(){
    if (!gInputState) return;
    const dateStr = document.getElementById('gInputDate').value;
    if (!dateStr) return;
    const utcDate = dateInputToUTC(dateStr);
    const ts = utcDate.getTime();
    const product = gInputState.product;
    const row = (gudangData.rows || []).find(r => r.ts === ts);
    const existing = (row && row.values[product]) || {};
    document.getElementById('gInputMasuk').value  = (existing.masuk  != null) ? existing.masuk  : '';
    document.getElementById('gInputKeluar').value = (existing.keluar != null) ? existing.keluar : '';
    document.getElementById('gInputSub').textContent =
      'Tanggal: ' + gudangFmtDate(utcDate) + (row && row.values[product] ? ' — data sudah ada, akan diperbarui' : ' — data baru');
    updateGInputPreview();
  }
  function updateGInputPreview(){
    if (!gInputState) return;
    const dateStr = document.getElementById('gInputDate').value;
    const el = document.getElementById('gInputPreview');
    if (!dateStr){ el.textContent = 'Pilih tanggal dulu.'; return; }
    const utcDate = dateInputToUTC(dateStr);
    const ts = utcDate.getTime();
    const product = gInputState.product;
    const before = gStokSebelum(product, ts);
    const masuk  = N(document.getElementById('gInputMasuk').value);
    const keluar = N(document.getElementById('gInputKeluar').value);
    const after  = before + masuk - keluar;
    el.innerHTML = 'Stok sebelum: <b>' + nfQty(before) + '</b> &nbsp;→&nbsp; Stok sesudah: <b>' + nfQty(after) + '</b><br>' +
      '(Masuk +' + nfQty(masuk) + ' &nbsp; Keluar -' + nfQty(keluar) + ')';
  }
  async function saveGInputModal(){
    if (!gInputState) return;
    const dateStr = document.getElementById('gInputDate').value;
    if (!dateStr) return alert('Pilih tanggal terlebih dahulu.');
    const product = gInputState.product;
    const masukRaw  = document.getElementById('gInputMasuk').value;
    const keluarRaw = document.getElementById('gInputKeluar').value;
    const masuk  = masukRaw  === '' ? null : Math.max(0, N(masukRaw));
    const keluar = keluarRaw === '' ? null : Math.max(0, N(keluarRaw));
    const utcDate = dateInputToUTC(dateStr);
    const ts = utcDate.getTime();

    if (!gudangData) gudangData = {products:[], saldoAwal:{}, rows:[]};
    if (!gudangData.products.includes(product)) gudangData.products.push(product);
    if (gudangData.saldoAwal[product] == null) gudangData.saldoAwal[product] = 0;

    let row = gudangData.rows.find(r => r.ts === ts);
    if (!row){
      row = {ts, tanggal: utcDate, values:{}};
      gudangData.rows.push(row);
      gudangData.rows.sort((a,b) => a.ts - b.ts);
    }
    row.values[product] = row.values[product] || {masuk:null, keluar:null, stok:null};
    row.values[product].masuk  = masuk;
    row.values[product].keluar = keluar;
    // Pastikan semua baris punya slot untuk produk ini, supaya running balance konsisten.
    gudangData.rows.forEach(r => { if (!r.values[product]) r.values[product] = {masuk:null, keluar:null, stok:null}; });
    // Hitung ulang STOK SFA (running balance) untuk produk ini dari saldo awal.
    let running = N(gudangData.saldoAwal[product]);
    gudangData.rows.forEach(r => {
      const v = r.values[product];
      running = running + N(v.masuk) - N(v.keluar);
      v.stok = running;
    });

    await saveGudangToDB(gudangData);
    renderGudangPage(gudangData);
    renderCekFitri();
    closeGInputModal();
    setGudangStatus('Stok "' + product + '" pada ' + gudangFmtDate(utcDate) + ' disimpan — Masuk ' + nfQty(masuk) + ', Keluar ' + nfQty(keluar) + '.');
  }
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape'){
      const ov = document.getElementById('gInputOverlay');
      if (ov && ov.classList.contains('show')) closeGInputModal();
    }
  });

  /* ------------- bootstrap ------------- */
  window.addEventListener('resize', () => {
    const b = document.getElementById('s0box');
    if (b && document.getElementById('panel_s0').offsetParent !== null) requestAnimationFrame(s0Render);
  });
  function applyTheme(mode){
    const dark = mode === 'dark';
    document.body.classList.toggle('dark', dark);
    const btn = document.getElementById('themeBtn');
    if (btn) btn.textContent = dark ? '☀️' : '🌙';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#1e3a5f' : '#1f4e78');
    try { localStorage.setItem('rekap-theme', dark ? 'dark' : 'light'); } catch(e){}
  }
  function toggleTheme(){
    applyTheme(document.body.classList.contains('dark') ? 'light' : 'dark');
  }
  function initTheme(){
    let mode = 'light';
    try {
      const saved = localStorage.getItem('rekap-theme');
      if (saved === 'dark' || saved === 'light') mode = saved;
      else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) mode = 'dark';
    } catch(e){}
    applyTheme(mode);
  }

  (async function init(){
    initTheme();
    initMainTabs();
    await initDB();
    initSupabase();
    if (sbClient){
      await pullFromCloud({ silent: true });
      subscribeRealtime();
    } else {
      await restoreFromDB();
      await loadGudangFromDB();
    }
  })();

  // Cegah pindah/tutup/refresh halaman saat masih ada upload ke cloud yang tertunda/berjalan,
  // supaya data yang baru saja diubah tidak sempat tertimpa data lama dari cloud saat reload.
  window.addEventListener('beforeunload', function(e){
    if (pushTimer || pushInFlight || isSyncingFromCloud) {
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
  });

  /* ------------- PWA: service worker + tombol instal ------------- */
  if ('serviceWorker' in navigator){
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW gagal daftar', e));
    });
  }
  let _deferredInstallPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    _deferredInstallPrompt = e;
    const btn = document.getElementById('installBtn');
    if (btn) btn.style.display = 'inline-block';
  });
  document.getElementById('installBtn')?.addEventListener('click', async () => {
    if (!_deferredInstallPrompt) return;
    _deferredInstallPrompt.prompt();
    await _deferredInstallPrompt.userChoice;
    _deferredInstallPrompt = null;
    document.getElementById('installBtn').style.display = 'none';
  });
  window.addEventListener('appinstalled', () => {
    const btn = document.getElementById('installBtn');
    if (btn) btn.style.display = 'none';
  });
