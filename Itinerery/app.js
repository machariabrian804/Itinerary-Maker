'use strict';

/* --------------------------------------------------------------------------
   Safari Quote — itinerary price maker
   Plain browser JavaScript. State lives in localStorage; contract browsing
   and PDF/Excel extraction are served by server.py.
--------------------------------------------------------------------------- */

const STORAGE_KEY = 'safariQuote.v2';
const DEFAULT_SHARE_URL =
  'https://1drv.ms/f/c/c6bd9a516690d040/IgCQLxHViUcZQrIw6ovUwuDUAS7stpyD4G113ctodZqgiKs?e=P9ao7Y';
const DEFAULT_FX = { USD: 1, KES: 130, EUR: 0.92, GBP: 0.79 };
const CURRENCIES = ['USD', 'KES', 'EUR', 'GBP'];
const CURRENCY_SYMBOL = { USD: 'US$', KES: 'KSh ', EUR: '€', GBP: '£' };
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic'];

const BASIS = {
  per_person_night: {
    label: 'Per person / night',
    unitsLabel: 'Adults',
    multiplier: 'nights',
    unitDefault: (q) => Math.max(1, num(q.adults, 1)),
    multDefault: (q) => quoteNights(q),
  },
  per_person: {
    label: 'Per person',
    unitsLabel: 'People',
    multiplier: null,
    unitDefault: (q) => Math.max(1, num(q.adults, 1)),
  },
  per_child_night: {
    label: 'Per child / night',
    unitsLabel: 'Children',
    multiplier: 'nights',
    unitDefault: (q) => Math.max(1, num(q.children, 1)),
    multDefault: (q) => quoteNights(q),
  },
  per_child: {
    label: 'Per child',
    unitsLabel: 'Children',
    multiplier: null,
    unitDefault: (q) => Math.max(1, num(q.children, 1)),
  },
  per_room_night: {
    label: 'Per room / night',
    unitsLabel: 'Rooms',
    multiplier: 'nights',
    unitDefault: (q) => Math.max(1, Math.ceil((num(q.adults, 1) + num(q.children, 0)) / 2)),
    multDefault: (q) => quoteNights(q),
  },
  per_night: {
    label: 'Per room / night (flat)',
    unitsLabel: 'Rooms',
    multiplier: 'nights',
    unitDefault: (q) => Math.max(1, Math.ceil((num(q.adults, 1) + num(q.children, 0)) / 2)),
    multDefault: (q) => quoteNights(q),
  },
  per_person_day: {
    label: 'Per person / day',
    unitsLabel: 'People',
    multiplier: 'days',
    unitDefault: (q) => Math.max(1, num(q.adults, 1)),
    multDefault: (q) => quoteNights(q),
  },
  per_group: {
    label: 'Per group / flat',
    unitsLabel: 'Groups',
    multiplier: null,
    unitDefault: () => 1,
  },
  per_group_day: {
    label: 'Per group / day',
    unitsLabel: 'Groups',
    multiplier: 'days',
    unitDefault: () => 1,
    multDefault: (q) => quoteNights(q),
  },
  per_vehicle: {
    label: 'Per vehicle',
    unitsLabel: 'Vehicles',
    multiplier: null,
    unitDefault: () => 1,
  },
  per_vehicle_day: {
    label: 'Per vehicle / day',
    unitsLabel: 'Vehicles',
    multiplier: 'days',
    unitDefault: () => 1,
    multDefault: (q) => quoteNights(q),
  },
  per_day: {
    label: 'Per day (flat)',
    unitsLabel: 'Groups',
    multiplier: 'days',
    unitDefault: () => 1,
    multDefault: (q) => quoteNights(q),
  },
};

/* --------------------------------------------------------------------------
   Small helpers
--------------------------------------------------------------------------- */

function uid(prefix) {
  const random =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function nowIso() {
  return new Date().toISOString();
}

function num(value, fallback = 0) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const cleaned = String(value == null ? '' : value).replace(/,/g, '').replace(/[^0-9.+-]/g, '');
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[character];
  });
}

function fmtAmount(value) {
  const number = num(value);
  const decimals = Math.abs(number - Math.round(number)) < 0.005 ? 0 : 2;
  return number.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtMoney(value, currency) {
  const code = CURRENCIES.includes(currency) ? currency : 'USD';
  return `${CURRENCY_SYMBOL[code]}${fmtAmount(value)}`;
}

function fmtDate(value) {
  if (!value) return '—';
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function fmtDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatSize(bytes) {
  const size = num(bytes);
  if (size < 1024) return `${Math.round(size)} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function partyLabel(quote) {
  const adults = Math.max(0, Math.round(num(quote.adults, 0)));
  const children = Math.max(0, Math.round(num(quote.children, 0)));
  const adultText = `${adults} adult${adults === 1 ? '' : 's'}`;
  if (!children) return adultText;
  return `${adultText} · ${children} ${children === 1 ? 'child' : 'children'}`;
}

function datesLabel(quote) {
  if (quote.startDate && quote.endDate) {
    return `${fmtDate(quote.startDate)} – ${fmtDate(quote.endDate)}`;
  }
  if (quote.startDate) return `From ${fmtDate(quote.startDate)}`;
  if (quote.endDate) return `Until ${fmtDate(quote.endDate)}`;
  return 'Dates on request';
}

function quoteNights(quote) {
  if (!quote || !quote.startDate || !quote.endDate) return 1;
  const start = new Date(`${quote.startDate}T00:00:00`);
  const end = new Date(`${quote.endDate}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 1;
  const nights = Math.round((end.getTime() - start.getTime()) / 86400000);
  return Math.max(1, nights);
}

function unitWord(label, count) {
  if (label === 'People') return count === 1 ? 'person' : 'people';
  if (label === 'Children') return 'children';
  const lower = String(label || 'unit').toLowerCase();
  if (count === 1) return lower.replace(/s$/, '');
  return lower;
}

function basisDefinition(key) {
  return BASIS[key] || BASIS.per_person_night;
}

function defaultUnitsFor(basisKey, quote) {
  const definition = basisDefinition(basisKey);
  return Math.max(0, Math.round(definition.unitDefault(quote)));
}

function defaultMultiplierFor(basisKey, quote) {
  const definition = basisDefinition(basisKey);
  if (!definition.multiplier) return 1;
  return Math.max(1, Math.round(definition.multDefault(quote)));
}

function convertCurrency(amount, fromCurrency, toCurrency) {
  const from = CURRENCIES.includes(fromCurrency) ? fromCurrency : 'USD';
  const to = CURRENCIES.includes(toCurrency) ? toCurrency : 'USD';
  if (from === to) return num(amount);
  const fx = state && state.settings && state.settings.fx ? state.settings.fx : DEFAULT_FX;
  const fromRate = Math.max(0.0001, num(fx[from], DEFAULT_FX[from] || 1));
  const toRate = Math.max(0.0001, num(fx[to], DEFAULT_FX[to] || 1));
  return (num(amount) / fromRate) * toRate;
}

function computeLine(line, quote) {
  const definition = basisDefinition(line.basis);
  const units = Math.max(0, num(line.units, 1));
  const multiplier = definition.multiplier ? Math.max(0, num(line.nights, 1)) : 1;
  const rate = Math.max(0, num(line.rate, 0));
  const net = rate * units * multiplier;
  const netQuote = convertCurrency(net, line.currency || quote.currency, quote.currency);
  const markupPercent =
    line.markup === null || line.markup === undefined || line.markup === ''
      ? Math.max(0, num(quote.markup, 0))
      : Math.max(0, num(line.markup, 0));
  const markup = netQuote * (markupPercent / 100);
  return {
    units,
    multiplier,
    rate,
    net,
    netQuote,
    markupPercent,
    markup,
    sell: netQuote + markup,
  };
}

function computeQuote(quote) {
  const rows = (quote.lines || []).map((line) => ({ line, calc: computeLine(line, quote) }));
  let net = 0;
  let markup = 0;
  let sell = 0;
  for (const row of rows) {
    net += row.calc.netQuote;
    markup += row.calc.markup;
    sell += row.calc.sell;
  }
  const pax = Math.max(1, num(quote.adults, 0) + num(quote.children, 0));
  return { rows, net, markup, sell, perPerson: sell / pax };
}

/* --------------------------------------------------------------------------
   State
--------------------------------------------------------------------------- */

function defaultSettings() {
  return {
    company: {
      name: 'Yobra Travel',
      tagline: 'Tailor-made safaris & itineraries',
      preparedBy: '',
      email: '',
      phone: '',
    },
    defaultMarkup: 10,
    defaultCurrency: 'USD',
    fx: { ...DEFAULT_FX },
    shareUrl: DEFAULT_SHARE_URL,
  };
}

function createStop(location = '', nights = 1) {
  return { id: uid('stop'), location: String(location || ''), nights: Math.max(1, Math.round(num(nights, 1))) };
}

function normalizeStop(raw) {
  const stop = raw && typeof raw === 'object' ? raw : {};
  return {
    id: String(stop.id || uid('stop')),
    location: String(stop.location || stop.destination || stop.name || ''),
    nights: Math.max(1, Math.round(num(stop.nights ?? stop.days, 1))),
  };
}

function createQuote(name = 'New itinerary', settings = null) {
  const source = settings || (state && state.settings) || defaultSettings();
  return {
    id: uid('quote'),
    name,
    client: '',
    destination: 'Kenya',
    startDate: '',
    endDate: '',
    adults: 2,
    children: 0,
    residency: 'non-resident',
    tripDays: 1,
    stops: [createStop('', 1)],
    currency: CURRENCIES.includes(source.defaultCurrency) ? source.defaultCurrency : 'USD',
    markup: Math.max(0, num(source.defaultMarkup, 10)),
    notes: '',
    lines: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function normalizeSettings(raw) {
  const fallback = defaultSettings();
  const settings = raw && typeof raw === 'object' ? raw : {};
  return {
    company: {
      ...fallback.company,
      ...(settings.company && typeof settings.company === 'object' ? settings.company : {}),
    },
    defaultMarkup: clamp(num(settings.defaultMarkup, fallback.defaultMarkup), 0, 100),
    defaultCurrency: CURRENCIES.includes(settings.defaultCurrency)
      ? settings.defaultCurrency
      : fallback.defaultCurrency,
    fx: {
      ...DEFAULT_FX,
      ...(settings.fx && typeof settings.fx === 'object' ? settings.fx : {}),
    },
    shareUrl: String(settings.shareUrl || fallback.shareUrl),
  };
}

function normalizeLine(raw, quoteCurrency) {
  const line = raw && typeof raw === 'object' ? raw : {};
  const basis = BASIS[line.basis] ? line.basis : 'per_person_night';
  const definition = BASIS[basis];
  const markup =
    line.markup === null || line.markup === undefined || line.markup === ''
      ? null
      : clamp(num(line.markup, 0), 0, 100);
  return {
    id: String(line.id || uid('line')),
    supplier: String(line.supplier || line.vendor || ''),
    description: String(line.description || line.item || line.service || ''),
    basis,
    rate: Math.max(0, num(line.rate ?? line.net ?? line.price ?? line.cost, 0)),
    currency: CURRENCIES.includes(line.currency) ? line.currency : quoteCurrency || 'USD',
    units: Math.max(0, num(line.units ?? line.qty ?? line.quantity, definition.unitDefault({ adults: 1, children: 1 }))),
    nights: definition.multiplier ? Math.max(0, num(line.nights ?? line.days ?? line.multiplier, 1)) : 1,
    markup,
    season: String(line.season || line.validity || ''),
    notes: String(line.notes || ''),
    source: String(line.source || line.file || ''),
  };
}

function normalizeQuote(raw) {
  const quote = raw && typeof raw === 'object' ? raw : {};
  const currency = CURRENCIES.includes(quote.currency) ? quote.currency : 'USD';
  const stopsRaw = Array.isArray(quote.stops) ? quote.stops : [];
  const stops = stopsRaw.map(normalizeStop).filter((stop) => stop.location || stop.nights);
  if (!stops.length) {
    const fallbackLocation = quote.destination && quote.destination.toLowerCase() !== 'kenya' ? quote.destination : '';
    stops.push(createStop(fallbackLocation, Math.max(1, quoteNights(quote))));
  }
  const tripDays = Math.max(1, Math.round(num(quote.tripDays, stops.reduce((sum, stop) => sum + stop.nights, 0) || 1)));
  const residency = ['resident', 'non-resident'].includes(String(quote.residency || '').toLowerCase())
    ? String(quote.residency).toLowerCase()
    : 'non-resident';
  return {
    id: String(quote.id || uid('quote')),
    name: String(quote.name || 'Untitled quote'),
    client: String(quote.client || ''),
    destination: String(quote.destination || ''),
    startDate: String(quote.startDate || ''),
    endDate: String(quote.endDate || ''),
    adults: Math.max(0, Math.round(num(quote.adults, 2))),
    children: Math.max(0, Math.round(num(quote.children, 0))),
    residency,
    tripDays,
    stops,
    currency,
    markup: clamp(num(quote.markup, 10), 0, 100),
    notes: String(quote.notes || ''),
    lines: Array.isArray(quote.lines) ? quote.lines.map((line) => normalizeLine(line, currency)) : [],
    createdAt: String(quote.createdAt || nowIso()),
    updatedAt: String(quote.updatedAt || nowIso()),
  };
}

function normalizeState(raw) {
  const settings = normalizeSettings(raw && raw.settings);
  const quotes = Array.isArray(raw && raw.quotes)
    ? raw.quotes.map(normalizeQuote)
    : [];
  if (!quotes.length) quotes.push(createQuote('Kenya itinerary', settings));
  const activeId =
    raw && quotes.some((quote) => quote.id === raw.activeId) ? raw.activeId : quotes[0].id;
  return { version: 2, activeId, settings, quotes };
}

let state = null;

function loadState() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    state = normalizeState(raw);
  } catch (error) {
    state = normalizeState(null);
  }
}

function activeQuote() {
  if (!state || !Array.isArray(state.quotes) || !state.quotes.length) {
    state = normalizeState(null);
  }
  return state.quotes.find((quote) => quote.id === state.activeId) || state.quotes[0];
}

function touchQuote(quote = activeQuote()) {
  quote.updatedAt = nowIso();
  return quote;
}

let saveTimer = null;

function saveState(immediate = false) {
  clearTimeout(saveTimer);
  setSaveIndicator('Saving…', true);
  const write = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      setSaveIndicator('Saved', false);
    } catch (error) {
      setSaveIndicator('Not saved', false);
      toast('Could not save to this browser. Export a backup instead.', 'error');
    }
  };
  if (immediate) write();
  else saveTimer = setTimeout(write, 350);
}

function setSaveIndicator(text, saving) {
  if (!dom.saveIndicator) return;
  dom.saveIndicator.textContent = text;
  dom.saveIndicator.classList.toggle('is-saving', Boolean(saving));
}

/* --------------------------------------------------------------------------
   Runtime state and DOM
--------------------------------------------------------------------------- */

const dom = {};
let activeView = 'quote';
let inventory = emptyInventory();
let serverOnline = false;
let serverCaps = {};
let isSyncing = false;
let activeFile = null;
let extraction = null;
const extractionByPath = new Map();
let activeConfidence = 'all';
let rateResidencyFilter = true;
let editingLineId = null;
let supplierSearchTimer = null;
let toastTimer = null;
let activeStopId = null;

function emptyInventory() {
  return {
    shareUrl: DEFAULT_SHARE_URL,
    supplierCount: 0,
    fileCount: 0,
    pdfCount: 0,
    syncedAt: '',
    suppliers: [],
  };
}

function cacheDom() {
  const ids = [
    'navRateCount',
    'syncStatus',
    'syncDot',
    'syncBtn',
    'contractLink',
    'quoteSelect',
    'newQuoteBtn',
    'duplicateQuoteBtn',
    'deleteQuoteBtn',
    'saveIndicator',
    'importBtn',
    'exportBtn',
    'printBtn',
    'offlineBanner',
    'markupInput',
    'quoteName',
    'clientName',
    'destination',
    'startDate',
    'endDate',
    'adults',
    'children',
    'quoteCurrency',
    'addManualLineBtn',
    'browseRatesBtn',
    'linesEmpty',
    'emptyBrowseBtn',
    'emptyManualBtn',
    'linesTableWrap',
    'linesBody',
    'linesFooter',
    'linesCurrency',
    'linesNetTotal',
    'tripDays',
    'residency',
    'plannerDays',
    'plannerDaysPlural',
    'plannerNights',
    'plannerNightsPlural',
    'addStopBtn',
    'stopsList',
    'hotelMatchesHint',
    'hotelMatchList',
    'quoteNotes',
    'summaryCurrency',
    'summaryTotal',
    'summaryNet',
    'summaryMarkupPct',
    'summaryMarkup',
    'summaryLines',
    'summaryPerPerson',
    'summaryBreakdown',
    'sidePrintBtn',
    'rateSearch',
    'rateExtFilter',
    'supplierList',
    'rateEmpty',
    'rateDetail',
    'rateSupplier',
    'rateFile',
    'rateMeta',
    'rateOpen',
    'rateExtractBtn',
    'rateImageWrap',
    'rateImage',
    'rateProgress',
    'rateProgressText',
    'rateResults',
    'confFilter',
    'candidateSearch',
    'candidateCount',
    'extractNote',
    'candidateList',
    'rawPages',
    'rateManual',
    'manualFromFileBtn',
    'companyName',
    'companyTagline',
    'preparedBy',
    'companyEmail',
    'companyPhone',
    'defaultMarkup',
    'defaultCurrency',
    'fxUsd',
    'fxKes',
    'fxEur',
    'fxGbp',
    'settingsSyncStatus',
    'shareUrl',
    'settingsSyncBtn',
    'settingsSyncMeta',
    'exportBackupBtn',
    'importBackupBtn',
    'resetBtn',
    'serverStatusLine',
    'lineModal',
    'lineModalEyebrow',
    'lineModalTitle',
    'lineForm',
    'lineId',
    'lineSupplier',
    'lineDescription',
    'lineBasis',
    'lineSeason',
    'lineRate',
    'lineCurrency',
    'lineUnitsLabel',
    'lineUnits',
    'lineMultiplierWrap',
    'lineMultiplierLabel',
    'lineMultiplier',
    'lineMarkup',
    'lineNotes',
    'lineSourceWrap',
    'lineSource',
    'linePreview',
    'lineDeleteBtn',
    'toast',
    'toastText',
    'toastAction',
    'csvFile',
    'backupFile',
    'printDoc',
  ];

  for (const id of ids) {
    dom[id] = document.getElementById(id);
  }
  dom.views = Array.from(document.querySelectorAll('.view'));
  dom.navItems = Array.from(document.querySelectorAll('.nav-item'));

  const missing = ids.filter((id) => !dom[id]);
  if (missing.length) console.warn('Safari Quote: missing elements', missing);
}

function populateBasisSelect() {
  dom.lineBasis.innerHTML = Object.entries(BASIS)
    .map(([key, definition]) => `<option value="${key}">${escapeHtml(definition.label)}</option>`)
    .join('');
}

/* --------------------------------------------------------------------------
   Boot
--------------------------------------------------------------------------- */

function boot() {
  loadState();
  cacheDom();
  populateBasisSelect();
  bindEvents();
  renderSettings();
  renderAll();
  loadServer();
}

async function loadServer() {
  try {
    const data = await api('/api/status');
    serverOnline = true;
    serverCaps = data;
    if (data.inventory && Array.isArray(data.inventory.suppliers) && data.inventory.suppliers.length) {
      inventory = data.inventory;
    } else if (window.ONEDRIVE_INVENTORY && Array.isArray(window.ONEDRIVE_INVENTORY.suppliers)) {
      inventory = window.ONEDRIVE_INVENTORY;
    } else {
      inventory = emptyInventory();
    }
    if (data.inventory && data.inventory.shareUrl && !state.settings.shareUrl) {
      state.settings.shareUrl = data.inventory.shareUrl;
    }
  } catch (error) {
    serverOnline = false;
    inventory =
      window.ONEDRIVE_INVENTORY && Array.isArray(window.ONEDRIVE_INVENTORY.suppliers)
        ? window.ONEDRIVE_INVENTORY
        : emptyInventory();
  }

  if (!inventory || !Array.isArray(inventory.suppliers)) inventory = emptyInventory();
  updateServerUI();
  renderSuppliers();
  updateRateActions();
  renderPlanner();
}

async function api(path, options = {}) {
  const request = {
    cache: 'no-store',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  };
  const response = await fetch(path, request);
  let data = {};
  try {
    data = await response.json();
  } catch (error) {
    data = {};
  }
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `Request failed (HTTP ${response.status})`);
  }
  return data;
}

/* --------------------------------------------------------------------------
   Views and shared chrome
--------------------------------------------------------------------------- */

function showView(name) {
  activeView = name;
  for (const view of dom.views) {
    view.classList.toggle('hidden', view.id !== `view-${name}`);
  }
  for (const button of dom.navItems) {
    button.classList.toggle('is-active', button.dataset.view === name);
  }
  if (name === 'rates') renderSuppliers();
  if (name === 'settings') {
    renderSettings();
    updateServerUI();
  }
  if (name === 'quote') renderSummary();
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
}

function updateServerUI() {
  if (!dom.syncDot) return;
  dom.syncDot.className = `status-dot ${serverOnline ? 'is-online' : 'is-offline'}`;
  dom.syncStatus.textContent = serverOnline
    ? `${num(inventory.fileCount, 0)} files · ${num(inventory.supplierCount, 0)} suppliers`
    : 'Server offline';
  dom.offlineBanner.classList.toggle('hidden', serverOnline);
  dom.syncBtn.disabled = !serverOnline || isSyncing;
  dom.settingsSyncBtn.disabled = !serverOnline || isSyncing;
  dom.navRateCount.textContent = num(inventory.fileCount, 0) || '—';
  dom.settingsSyncStatus.textContent = serverOnline ? 'Server online' : 'Server offline';
  dom.settingsSyncStatus.classList.toggle('is-online', serverOnline);
  dom.settingsSyncMeta.textContent = inventory.syncedAt
    ? `Last synced ${fmtDateTime(inventory.syncedAt)}`
    : '';
  dom.serverStatusLine.textContent = serverOnline
    ? `Local server online${
        serverCaps.pdfSupport === false || serverCaps.xlsxSupport === false
          ? ' · install requirements.txt for full PDF/Excel support'
          : ''
      }`
    : 'Local server offline — rate extraction is unavailable. Run python3 server.py to enable it.';
  if (state && state.settings) {
    if (!state.settings.shareUrl && inventory.shareUrl) state.settings.shareUrl = inventory.shareUrl;
    dom.shareUrl.value = state.settings.shareUrl || inventory.shareUrl || '';
    dom.contractLink.href = state.settings.shareUrl || inventory.shareUrl || '#';
  }
}

function setSyncing(syncing) {
  isSyncing = syncing;
  dom.syncBtn.textContent = syncing ? 'Syncing…' : 'Sync OneDrive';
  dom.settingsSyncBtn.textContent = syncing ? 'Syncing…' : 'Sync library';
  dom.syncBtn.disabled = syncing || !serverOnline;
  dom.settingsSyncBtn.disabled = syncing || !serverOnline;
  if (syncing) {
    dom.syncStatus.textContent = 'Refreshing contract list…';
    dom.syncDot.className = 'status-dot';
  }
}

async function syncLibrary() {
  if (!serverOnline) {
    toast('Start the local server first: python3 server.py', 'error');
    return;
  }
  if (isSyncing) return;
  const url = state.settings.shareUrl || inventory.shareUrl || DEFAULT_SHARE_URL;
  setSyncing(true);
  try {
    const data = await api('/api/sync', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
    inventory = data.inventory;
    if (inventory.shareUrl) state.settings.shareUrl = inventory.shareUrl;
    saveState(true);
    updateServerUI();
    renderSuppliers({ resetScroll: true });
    toast(`Synced ${num(inventory.fileCount, 0)} files from ${num(inventory.supplierCount, 0)} suppliers.`);
  } catch (error) {
    toast(`Sync failed: ${error.message}`, 'error');
  } finally {
    setSyncing(false);
    updateServerUI();
  }
}

function toast(message, type = 'info', action = null) {
  clearTimeout(toastTimer);
  dom.toastText.textContent = message;
  dom.toast.classList.remove('hidden');
  dom.toast.classList.toggle('is-error', type === 'error');
  if (action) {
    dom.toastAction.textContent = action.label;
    dom.toastAction.classList.remove('hidden');
    dom.toastAction.onclick = () => {
      hideToast();
      action.onClick();
    };
  } else {
    dom.toastAction.classList.add('hidden');
    dom.toastAction.onclick = null;
  }
  toastTimer = setTimeout(hideToast, action ? 6500 : 3600);
}

function hideToast() {
  clearTimeout(toastTimer);
  dom.toast.classList.add('hidden');
}

/* --------------------------------------------------------------------------
   Quote rendering
--------------------------------------------------------------------------- */

function renderAll() {
  renderQuoteSelect();
  renderQuoteMeta();
  renderLines();
  renderSummary();
  renderPrintDoc();
  if (activeView === 'rates') renderSuppliers();
}

function renderQuoteSelect() {
  const options = state.quotes
    .map((quote) => {
      const name = quote.name || 'Untitled quote';
      const label = quote.client ? `${name} — ${quote.client}` : name;
      return `<option value="${escapeHtml(quote.id)}">${escapeHtml(label)}</option>`;
    })
    .join('');
  dom.quoteSelect.innerHTML = options;
  dom.quoteSelect.value = state.activeId;
}

function totalNights(quote = activeQuote()) {
  return (quote.stops || []).reduce((sum, stop) => sum + Math.max(0, Math.round(num(stop.nights, 0))), 0);
}

function ensureActiveStop(quote = activeQuote()) {
  if (!quote.stops || !quote.stops.length) quote.stops = [createStop(quote.destination || '', 1)];
  if (!activeStopId || !quote.stops.some((stop) => stop.id === activeStopId)) {
    activeStopId = quote.stops[0].id;
  }
  return quote.stops.find((stop) => stop.id === activeStopId) || quote.stops[0];
}

function syncTripDays(quote = activeQuote()) {
  const nights = totalNights(quote);
  quote.tripDays = Math.max(1, nights || Math.round(num(quote.tripDays, 1)) || 1);
  return quote.tripDays;
}

const LOCATION_ALIASES = {
  mara: ['mara', 'masai', 'governor', 'angama', 'keekorok', 'olare', 'serena mara', 'basecamp'],
  nairobi: ['nairobi', 'nbo', 'wilson', 'jkia', 'carnivore'],
  amboseli: ['amboseli', 'kimana', 'sinet', 'tortilis', 'ol tukai'],
  diani: ['diani', 'ukunda', 'south coast'],
  mombasa: ['mombasa', 'nyali', 'bamburi', 'shanzu'],
  malindi: ['malindi', 'watamu', 'kilifi'],
  watamu: ['watamu', 'malindi'],
  naivasha: ['naivasha', 'elementaita', 'hells gate', 'hell gate'],
  nakuru: ['nakuru', 'elementaita', 'bogoria'],
  samburu: ['samburu', 'shaba', 'buffalo springs'],
  olpejeta: ['ol pejeta', 'olpejeta', 'nanyuki', 'sweetwaters'],
  nanyuki: ['nanyuki', 'ol pejeta', 'sweetwaters', 'mt kenya', 'mount kenya'],
  tsavo: ['tsavo', 'taita', 'voi', 'salt lick'],
  meru: ['meru'],
  laikipia: ['laikipia', 'lewa', 'borana', 'segera'],
  lamu: ['lamu'],
};

function locationTokens(location) {
  const raw = String(location || '').toLowerCase();
  const tokens = raw
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !['and', 'the', 'for', 'with', 'days', 'night', 'nights', 'camp', 'hotel', 'lodge', 'kenya'].includes(token));
  const extra = [];
  for (const [key, aliases] of Object.entries(LOCATION_ALIASES)) {
    if (raw.includes(key) || tokens.includes(key)) extra.push(...aliases);
  }
  for (const token of tokens) {
    for (const [key, aliases] of Object.entries(LOCATION_ALIASES)) {
      if (key.includes(token) || token.includes(key)) extra.push(...aliases);
    }
  }
  return Array.from(new Set([...tokens, ...extra.map((v) => v.toLowerCase())])).filter((t) => t.length >= 3);
}

function residencyFromText(text) {
  const value = String(text || '').toLowerCase();
  const hasResident = /\bresident\b/.test(value);
  const hasNonResident = /non[\s-]?resident/.test(value);
  if (hasNonResident) return 'non-resident';
  if (hasResident) return 'resident';
  return 'unknown';
}

function fileMatchesResidency(file, residency) {
  const kind = residencyFromText(`${file.name || ''} ${file.path || ''}`);
  if (residency === 'resident') return kind !== 'non-resident';
  return kind !== 'resident';
}

function scoreSupplierForStop(supplier, stop, residency) {
  const tokens = locationTokens(stop.location);
  if (!tokens.length) return 0;
  const name = String(supplier.name || '').toLowerCase();
  const files = Array.isArray(supplier.files) ? supplier.files : [];
  const fileBlob = files.map((file) => String(file.name || '').toLowerCase()).join(' ');
  let score = 0;

  for (const token of tokens) {
    if (name.includes(token)) score += 8;
    if (fileBlob.includes(token)) score += 2;
  }
  if (!score) return 0;

  const residencyFiles = files.filter((file) => fileMatchesResidency(file, residency));
  if (residencyFiles.length) score += 3;
  if (files.some((file) => residencyFromText(file.name) === residency)) score += 4;
  if (residency === 'non-resident' && files.some((file) => /rack|sto|international|non[\s-]?resident/.test(String(file.name).toLowerCase()))) {
    score += 2;
  }
  if (residency === 'resident' && files.some((file) => /\bkes\b|resident/.test(String(file.name).toLowerCase()))) {
    score += 2;
  }
  return score;
}

function matchingHotelsForStop(stop, residency) {
  if (!inventory || !Array.isArray(inventory.suppliers)) return [];
  const tokens = locationTokens(stop.location);
  if (!tokens.length) return [];
  return inventory.suppliers
    .map((supplier) => ({ supplier, score: scoreSupplierForStop(supplier, stop, residency) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.supplier.name.localeCompare(b.supplier.name))
    .slice(0, 12)
    .map(({ supplier }) => supplier);
}

function renderQuoteMeta() {
  const quote = activeQuote();
  dom.quoteName.value = quote.name || '';
  dom.clientName.value = quote.client || '';
  dom.destination.value = quote.destination || '';
  dom.startDate.value = quote.startDate || '';
  dom.endDate.value = quote.endDate || '';
  dom.adults.value = quote.adults;
  dom.children.value = quote.children;
  dom.quoteCurrency.value = quote.currency;
  dom.markupInput.value = quote.markup;
  dom.quoteNotes.value = quote.notes || '';
  dom.linesCurrency.textContent = quote.currency;
  renderPlanner();
}

function renderPlanner() {
  const quote = activeQuote();
  ensureActiveStop(quote);
  syncTripDays(quote);

  dom.tripDays.value = quote.tripDays;
  dom.residency.value = quote.residency || 'non-resident';
  const nights = totalNights(quote);
  dom.plannerDays.textContent = String(quote.tripDays);
  dom.plannerNights.textContent = String(nights);
  dom.plannerDaysPlural.textContent = quote.tripDays === 1 ? '' : 's';
  dom.plannerNightsPlural.textContent = nights === 1 ? '' : 's';

  renderStops();
  renderHotelMatches();
}

function renderStops() {
  const quote = activeQuote();
  ensureActiveStop(quote);
  dom.stopsList.innerHTML = quote.stops
    .map((stop, index) => {
      const active = stop.id === activeStopId;
      return `
        <div class="stop-row ${active ? 'is-active' : ''}" data-stop-id="${escapeHtml(stop.id)}">
          <label class="field">
            <span>Location ${index + 1}</span>
            <input type="text" data-stop-field="location" data-stop-id="${escapeHtml(stop.id)}" value="${escapeHtml(stop.location)}" placeholder="e.g. Masai Mara, Amboseli, Diani">
          </label>
          <label class="field">
            <span>Nights</span>
            <input type="number" min="1" step="1" inputmode="numeric" data-stop-field="nights" data-stop-id="${escapeHtml(stop.id)}" value="${escapeHtml(stop.nights)}">
          </label>
          <button class="icon-btn stop-remove danger-hover" type="button" data-stop-remove="${escapeHtml(stop.id)}" title="Remove stop" aria-label="Remove stop" ${quote.stops.length === 1 ? 'disabled' : ''}>✕</button>
        </div>`;
    })
    .join('');
}

function renderHotelMatches() {
  const quote = activeQuote();
  const stop = ensureActiveStop(quote);
  const residency = quote.residency || 'non-resident';
  const location = stop.location.trim();
  const matches = matchingHotelsForStop(stop, residency);

  if (!location) {
    dom.hotelMatchesHint.textContent = 'Type a location in a stop to see matching hotels and contracts.';
    dom.hotelMatchList.innerHTML = '<div class="match-empty">Add a location like “Masai Mara”, “Amboseli”, “Naivasha”, “Diani” or “Nairobi”.</div>';
    return;
  }

  dom.hotelMatchesHint.textContent = matches.length
    ? `${matches.length} match${matches.length === 1 ? '' : 'es'} for “${location}” · ${residency === 'resident' ? 'Resident' : 'Non-resident'}`
    : `No direct matches for “${location}”. Try a nearby area name or browse the full rate library.`;

  if (!matches.length) {
    dom.hotelMatchList.innerHTML = '<div class="match-empty">No matching hotels found in the synced contract library. Try another location spelling, or open the full Rate library.</div>';
    return;
  }

  dom.hotelMatchList.innerHTML = matches
    .map((supplier) => {
      const files = (supplier.files || []).filter((file) => isExtractable(file) || isImageFile(file));
      const preferred = files.filter((file) => fileMatchesResidency(file, residency));
      const showFiles = (preferred.length ? preferred : files).slice(0, 3);
      const fileChips = showFiles
        .map((file) => {
          const idx = (supplier.files || []).indexOf(file);
          return `<button class="hotel-file" type="button" data-open-supplier="${escapeHtml(supplier.id)}" data-open-file="${idx}" title="${escapeHtml(file.name)}"><span class="ext-badge ${extClass(file)}">${escapeHtml(fileExt(file) || 'file')}</span><span>${escapeHtml(file.name)}</span></button>`;
        })
        .join('');
      return `
        <article class="hotel-card">
          <div class="hotel-card-head">
            <div>
              <h4>${escapeHtml(supplier.name)}</h4>
              <div class="hotel-meta">${supplier.files.length} file${supplier.files.length === 1 ? '' : 's'} in contract library</div>
            </div>
          </div>
          <div class="hotel-files">${fileChips || '<span class="hotel-meta">No extractable rate files</span>'}</div>
          <div class="hotel-actions">
            <button class="btn btn-primary" type="button" data-browse-supplier="${escapeHtml(supplier.id)}">Browse rates</button>
          </div>
        </article>`;
    })
    .join('');
}

function unitsText(line, calc) {
  const definition = basisDefinition(line.basis);
  const units = `${fmtAmount(calc.units)} ${unitWord(definition.unitsLabel, calc.units)}`;
  if (!definition.multiplier) return units;
  return `${units} × ${fmtAmount(calc.multiplier)} ${definition.multiplier}`;
}

function shortText(value, max = 48) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function renderLines() {
  const quote = activeQuote();
  const total = computeQuote(quote);
  const hasLines = quote.lines.length > 0;

  dom.linesEmpty.classList.toggle('hidden', hasLines);
  dom.linesTableWrap.classList.toggle('hidden', !hasLines);
  dom.linesFooter.classList.toggle('hidden', !hasLines);
  dom.linesNetTotal.textContent = fmtMoney(total.net, quote.currency);

  dom.linesBody.innerHTML = total.rows
    .map(({ line, calc }, index) => {
      const definition = basisDefinition(line.basis);
      const converted =
        line.currency !== quote.currency
          ? `<small>≈ ${fmtMoney(calc.netQuote, quote.currency)}</small>`
          : '';
      const source = line.source
        ? `<span class="line-season" title="${escapeHtml(line.source)}">${escapeHtml(shortText(line.source, 52))}</span>`
        : '';
      const season = line.season
        ? `<span class="line-season">${escapeHtml(line.season)}</span>`
        : '';
      return `
        <tr data-line-id="${escapeHtml(line.id)}">
          <td>
            <div class="line-service">
              <strong>${escapeHtml(line.description || 'Untitled service')}</strong>
              ${line.supplier ? `<span>${escapeHtml(line.supplier)}</span>` : ''}
              ${season}
              ${source}
            </div>
          </td>
          <td><span class="basis-pill">${escapeHtml(definition.label)}</span></td>
          <td class="num">
            ${escapeHtml(unitsText(line, calc))}
          </td>
          <td class="num line-rate">
            ${fmtMoney(line.rate, line.currency)}
            ${converted}
          </td>
          <td class="num line-markup">
            ${fmtAmount(calc.markupPercent)}%
            <small>+${fmtMoney(calc.markup, quote.currency)}</small>
          </td>
          <td class="num line-sell">
            <strong>${fmtMoney(calc.sell, quote.currency)}</strong>
          </td>
          <td>
            <div class="row-actions">
              <button class="mini-btn" type="button" data-line-action="up" data-line-id="${escapeHtml(line.id)}" title="Move up" aria-label="Move up" ${index === 0 ? 'disabled' : ''}>↑</button>
              <button class="mini-btn" type="button" data-line-action="down" data-line-id="${escapeHtml(line.id)}" title="Move down" aria-label="Move down" ${index === total.rows.length - 1 ? 'disabled' : ''}>↓</button>
              <button class="mini-btn" type="button" data-line-action="duplicate" data-line-id="${escapeHtml(line.id)}" title="Duplicate" aria-label="Duplicate">⧉</button>
              <button class="mini-btn" type="button" data-line-action="edit" data-line-id="${escapeHtml(line.id)}" title="Edit" aria-label="Edit">✎</button>
              <button class="mini-btn danger" type="button" data-line-action="delete" data-line-id="${escapeHtml(line.id)}" title="Delete" aria-label="Delete">✕</button>
            </div>
          </td>
        </tr>`;
    })
    .join('');
}

function renderSummary() {
  const quote = activeQuote();
  const total = computeQuote(quote);
  dom.summaryCurrency.textContent = quote.currency;
  dom.summaryTotal.textContent = fmtAmount(total.sell);
  dom.summaryNet.textContent = fmtMoney(total.net, quote.currency);
  dom.summaryMarkupPct.textContent = `${fmtAmount(quote.markup)}%`;
  dom.summaryMarkup.textContent = fmtMoney(total.markup, quote.currency);
  dom.summaryLines.textContent = String(quote.lines.length);
  dom.summaryPerPerson.textContent = fmtMoney(total.perPerson, quote.currency);
  dom.linesCurrency.textContent = quote.currency;

  const groups = new Map();
  for (const { line, calc } of total.rows) {
    const key = line.supplier || 'Other services';
    groups.set(key, (groups.get(key) || 0) + calc.sell);
  }
  const entries = Array.from(groups.entries())
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const max = entries.length ? entries[0][1] : 1;
  dom.summaryBreakdown.innerHTML = entries
    .map(
      ([name, value]) => `
      <div class="breakdown-row">
        <span title="${escapeHtml(name)}">${escapeHtml(name)}</span>
        <strong>${fmtMoney(value, quote.currency)}</strong>
        <div class="breakdown-bar"><i style="width:${Math.max(3, (value / max) * 100).toFixed(1)}%"></i></div>
      </div>`
    )
    .join('');
}

function renderPrintDoc() {
  const quote = activeQuote();
  const total = computeQuote(quote);
  const company = state.settings.company || {};
  const companyName = company.name || 'Safari Quote';
  const contact = [company.email, company.phone].filter(Boolean).join(' · ');
  const prepared = company.preparedBy ? `Prepared by ${company.preparedBy}` : '';
  const today = fmtDate(nowIso().slice(0, 10));
  const quoteTitle = quote.name || 'Safari itinerary';

  const rows = total.rows.length
    ? total.rows
        .map(({ line, calc }) => {
          const definition = basisDefinition(line.basis);
          const conversion =
            line.currency !== quote.currency
              ? `<span>≈ ${fmtMoney(calc.netQuote, quote.currency)} converted</span>`
              : '';
          return `
            <tr>
              <td class="service">
                <strong>${escapeHtml(line.description || 'Untitled service')}</strong>
                ${line.supplier ? `<span>${escapeHtml(line.supplier)}</span>` : ''}
                ${line.season ? `<span>${escapeHtml(line.season)}</span>` : ''}
              </td>
              <td>${escapeHtml(definition.label)}</td>
              <td class="num">${escapeHtml(unitsText(line, calc))}</td>
              <td class="num">${fmtMoney(line.rate, line.currency)}${conversion}</td>
              <td class="num">${fmtAmount(calc.markupPercent)}%</td>
              <td class="num"><strong>${fmtMoney(calc.sell, quote.currency)}</strong></td>
            </tr>`;
        })
        .join('')
    : '<tr><td colspan="6">No services added yet.</td></tr>';

  dom.printDoc.innerHTML = `
    <article class="print-doc">
      <header class="print-head">
        <div class="print-brand">
          <div class="print-mark">${escapeHtml((companyName || 'S').slice(0, 1))}</div>
          <div>
            <h1>${escapeHtml(companyName)}</h1>
            <p>${escapeHtml(company.tagline || 'Tailor-made safaris & itineraries')}</p>
          </div>
        </div>
        <div class="print-title">
          <strong>Quotation</strong>
          <h2>${escapeHtml(quoteTitle)}</h2>
          <p>Prepared ${escapeHtml(today)}</p>
        </div>
      </header>

      <section class="print-meta">
        <div><span>Client</span><strong>${escapeHtml(quote.client || '—')}</strong></div>
        <div><span>Destination</span><strong>${escapeHtml(quote.destination || '—')}</strong></div>
        <div><span>Travel dates</span><strong>${escapeHtml(datesLabel(quote))}</strong></div>
        <div><span>Party</span><strong>${escapeHtml(partyLabel(quote))}</strong></div>
      </section>

      <table class="print-table">
        <thead>
          <tr>
            <th>Service</th>
            <th>Basis</th>
            <th class="num">Units</th>
            <th class="num">Net rate</th>
            <th class="num">Markup</th>
            <th class="num">Total</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>

      <section class="print-summary">
        <div class="print-summary-box">
          <div class="print-summary-row"><span>Net contract cost</span><span>${fmtMoney(total.net, quote.currency)}</span></div>
          <div class="print-summary-row"><span>Markup (${fmtAmount(quote.markup)}%)</span><span>${fmtMoney(total.markup, quote.currency)}</span></div>
          <div class="print-summary-row total"><span>Total ${escapeHtml(quote.currency)}</span><span>${fmtMoney(total.sell, quote.currency)}</span></div>
          <div class="print-summary-row"><span>Per person</span><span>${fmtMoney(total.perPerson, quote.currency)}</span></div>
        </div>
      </section>

      ${
        quote.notes
          ? `<section class="print-notes"><h3>Notes &amp; terms</h3><p>${escapeHtml(quote.notes)}</p></section>`
          : ''
      }

      <footer class="print-footer">
        ${escapeHtml(contact || companyName)}${prepared ? ` · ${escapeHtml(prepared)}` : ''}<br>
        Quotation prepared ${escapeHtml(today)}. All rates are subject to availability at the time of booking.
      </footer>
    </article>`;
}

function printQuote() {
  showView('quote');
  renderPrintDoc();
  setTimeout(() => window.print(), 60);
}

/* --------------------------------------------------------------------------
   Rate library
--------------------------------------------------------------------------- */

let isExtracting = false;
let extractionToken = 0;

function fileExt(file) {
  return String((file && file.ext) || (file && file.name ? file.name.split('.').pop() : '') || '').toLowerCase();
}

function isExtractable(file) {
  const ext = fileExt(file);
  return ext === 'pdf' || ext === 'xlsx';
}

function isImageFile(file) {
  return IMAGE_EXTENSIONS.includes(fileExt(file));
}

function extClass(file) {
  const ext = fileExt(file);
  if (ext === 'pdf') return 'ext-pdf';
  if (ext === 'xlsx' || ext === 'xls') return 'ext-xlsx';
  if (IMAGE_EXTENSIONS.includes(ext)) return 'ext-img';
  return 'ext-other';
}

function matchesRateFilter(file, filter) {
  if (filter === 'extractable') return isExtractable(file);
  return true;
}

function renderSuppliers({ resetScroll = false } = {}) {
  if (!dom.supplierList) return;
  const query = dom.rateSearch.value.trim().toLowerCase();
  const filter = dom.rateExtFilter.value;
  const previousScroll = resetScroll ? 0 : dom.supplierList.scrollTop;

  if (!inventory || !Array.isArray(inventory.suppliers) || !inventory.suppliers.length) {
    dom.supplierList.innerHTML =
      '<div class="supplier-empty">No contracts loaded. Start the local server and sync the OneDrive folder.</div>';
    return;
  }

  let html = '';
  inventory.suppliers.forEach((supplier, supplierIndex) => {
    const files = Array.isArray(supplier.files) ? supplier.files : [];
    const filteredFiles = files
      .map((file, fileIndex) => ({ file, fileIndex }))
      .filter(({ file }) => matchesRateFilter(file, filter));
    if (!filteredFiles.length) return;

    const supplierMatches = supplier.name.toLowerCase().includes(query);
    const visibleFiles = query
      ? supplierMatches
        ? filteredFiles
        : filteredFiles.filter(({ file }) => file.name.toLowerCase().includes(query))
      : filteredFiles;
    if (!visibleFiles.length) return;

    const isActiveSupplier = activeFile && activeFile.supplier === supplier.name;
    const open = Boolean(query) || isActiveSupplier;
    html += `<details class="supplier" data-supplier-index="${supplierIndex}" ${open ? 'open' : ''}>
      <summary title="${escapeHtml(supplier.name)}">
        <span class="supplier-name">${escapeHtml(supplier.name)}</span>
        <span class="supplier-count">${files.length}</span>
      </summary>
      <div class="file-list">`;

    for (const { file, fileIndex } of visibleFiles) {
      const active = activeFile && activeFile.file.path === file.path;
      html += `<button class="file-item ${active ? 'is-active' : ''}" type="button"
          data-supplier-index="${supplierIndex}" data-file-index="${fileIndex}"
          title="${escapeHtml(file.name)}">
        <span class="ext-badge ${extClass(file)}">${escapeHtml(fileExt(file) || 'file')}</span>
        <span class="file-copy">
          <span class="file-name">${escapeHtml(file.name)}</span>
          <span class="file-size">${formatSize(file.size)}</span>
        </span>
      </button>`;
    }

    html += '</div></details>';
  });

  dom.supplierList.innerHTML = html || '<div class="supplier-empty">No matching files.</div>';
  dom.supplierList.scrollTop = previousScroll;
}

function fileUrl(file, download = false) {
  return `/api/file?path=${encodeURIComponent(file.path)}${download ? '&download=1' : ''}`;
}

function selectFile(supplierIndex, fileIndex) {
  if (!inventory || !inventory.suppliers[supplierIndex]) return;
  const supplier = inventory.suppliers[supplierIndex];
  const file = supplier.files[fileIndex];
  if (!file) return;

  activeFile = { supplier: supplier.name, supplierObj: supplier, file };
  extraction = extractionByPath.get(file.path) || null;
  activeConfidence = 'all';
  dom.candidateSearch.value = '';
  updateConfidenceButtons();
  renderSuppliers();
  renderFileDetail();
}

function openSupplierInRates(supplierId) {
  if (!inventory || !Array.isArray(inventory.suppliers)) return;
  const supplierIndex = inventory.suppliers.findIndex((supplier) => supplier.id === supplierId);
  if (supplierIndex < 0) return;
  const supplier = inventory.suppliers[supplierIndex];
  dom.rateSearch.value = supplier.name;
  dom.rateExtFilter.value = 'all';
  showView('rates');
  renderSuppliers({ resetScroll: true });
  const details = dom.supplierList.querySelector(`details[data-supplier-index="${supplierIndex}"]`);
  if (details) {
    details.open = true;
    details.scrollIntoView({ block: 'nearest' });
  }
}

function openSupplierFile(supplierId, fileIndex) {
  if (!inventory || !Array.isArray(inventory.suppliers)) return;
  const supplierIndex = inventory.suppliers.findIndex((supplier) => supplier.id === supplierId);
  if (supplierIndex < 0) return;
  openSupplierInRates(supplierId);
  selectFile(supplierIndex, fileIndex);
  const active = dom.supplierList.querySelector(`.file-item[data-supplier-index="${supplierIndex}"][data-file-index="${fileIndex}"]`);
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function renderFileDetail() {
  if (!activeFile) return;
  const { supplier, file } = activeFile;
  dom.rateEmpty.classList.add('hidden');
  dom.rateDetail.classList.remove('hidden');
  dom.rateSupplier.textContent = supplier;
  dom.rateFile.textContent = file.name;
  dom.rateMeta.textContent = [
    (fileExt(file) || 'file').toUpperCase(),
    formatSize(file.size),
    file.modified ? `updated ${fmtDateTime(file.modified)}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const canOpen = serverOnline;
  dom.rateOpen.href = canOpen ? fileUrl(file) : '#';
  dom.rateOpen.classList.toggle('is-disabled', !canOpen);
  dom.rateOpen.setAttribute('aria-disabled', String(!canOpen));
  dom.rateOpen.title = canOpen ? 'Open file' : 'Start the local server to open files';

  if (isImageFile(file) && serverOnline) {
    dom.rateImageWrap.classList.remove('hidden');
    dom.rateImage.src = fileUrl(file);
    dom.rateImage.alt = file.name;
  } else {
    dom.rateImageWrap.classList.add('hidden');
    dom.rateImage.removeAttribute('src');
  }

  dom.rateProgress.classList.add('hidden');
  updateRateActions();

  if (extraction) {
    renderExtraction();
  } else {
    dom.rateResults.classList.add('hidden');
    dom.extractNote.classList.add('hidden');
    dom.candidateList.innerHTML = '';
    dom.rawPages.innerHTML = '';
    dom.candidateCount.textContent = '';
  }
}

function updateRateActions() {
  if (!dom.rateExtractBtn) return;
  const file = activeFile && activeFile.file;
  const canExtract = Boolean(serverOnline && file && isExtractable(file) && !isExtracting);
  dom.rateExtractBtn.disabled = !canExtract;
  dom.rateExtractBtn.textContent = isExtracting
    ? 'Extracting…'
    : extraction
      ? 'Re-extract rates'
      : 'Extract rates';
  if (!serverOnline) {
    dom.rateExtractBtn.title = 'Start the local server to extract rates';
  } else if (file && !isExtractable(file)) {
    dom.rateExtractBtn.title = 'Only PDF and Excel files can be parsed';
  } else {
    dom.rateExtractBtn.title = '';
  }
}

async function extractActiveFile() {
  if (!activeFile) return;
  const file = activeFile.file;
  if (!isExtractable(file)) {
    toast('Only PDF and Excel files can be parsed. Open this file or add a rate manually.', 'error');
    return;
  }
  if (!serverOnline) {
    toast('Start the local server to extract rates: python3 server.py', 'error');
    return;
  }

  const token = ++extractionToken;
  isExtracting = true;
  updateRateActions();
  dom.rateResults.classList.add('hidden');
  dom.rateProgress.classList.remove('hidden');
  dom.rateProgressText.textContent = 'Downloading and reading the contract…';

  const slowTimer = setTimeout(() => {
    if (isExtracting && token === extractionToken) {
      dom.rateProgressText.textContent = 'Still reading — large contracts can take a minute.';
    }
  }, 9000);

  try {
    const data = await api('/api/extract', {
      method: 'POST',
      body: JSON.stringify({ path: file.path }),
    });
    if (token !== extractionToken) return;
    if (!activeFile || activeFile.file.path !== file.path) return;
    extraction = data;
    extractionByPath.set(file.path, data);
    renderExtraction();
    const count = Array.isArray(data.candidates) ? data.candidates.length : 0;
    if (count) {
      toast(`Found ${count} rate candidate${count === 1 ? '' : 's'} in ${file.name}.`);
    } else {
      toast('No rates found. Check the extracted text or add a rate manually.', 'error');
    }
  } catch (error) {
    if (token !== extractionToken) return;
    dom.rateProgressText.textContent = 'Extraction failed.';
    toast(`Could not extract: ${error.message}`, 'error');
  } finally {
    clearTimeout(slowTimer);
    if (token === extractionToken) {
      isExtracting = false;
      dom.rateProgress.classList.add('hidden');
      updateRateActions();
    }
  }
}

function renderExtraction() {
  if (!extraction) {
    dom.rateResults.classList.add('hidden');
    return;
  }
  dom.rateResults.classList.remove('hidden');
  dom.extractNote.textContent = extraction.notes || '';
  dom.extractNote.classList.toggle('hidden', !extraction.notes);
  renderCandidates();

  const pages = Array.isArray(extraction.pages) ? extraction.pages : [];
  dom.rawPages.innerHTML = pages.length
    ? pages
        .map((page) => {
          const title = page.name ? `${page.name} · page ${page.page}` : `Page ${page.page}`;
          const text = String(page.text || '').slice(0, 12000);
          return `<div class="raw-page"><h4>${escapeHtml(title)}</h4><pre>${escapeHtml(text)}</pre></div>`;
        })
        .join('')
    : '<p class="muted small">No text was returned for this file.</p>';
}

function renderCandidates() {
  if (!extraction || !Array.isArray(extraction.candidates)) {
    dom.candidateList.innerHTML = '';
    dom.candidateCount.textContent = '';
    return;
  }
  const quote = activeQuote();
  const wantedResidency = quote.residency === 'resident' ? 'resident' : 'non-resident';
  const query = dom.candidateSearch.value.trim().toLowerCase();
  const all = extraction.candidates;
  const decorated = all.map((candidate) => {
    const residency = candidateResidency(candidate, activeFile && activeFile.file);
    return { candidate, residency };
  });

  const filtered = decorated.filter(({ candidate, residency }) => {
    if (activeConfidence !== 'all' && candidate.confidence !== activeConfidence) return false;
    if (rateResidencyFilter && residency !== 'unknown' && residency !== wantedResidency) return false;
    if (!query) return true;
    const haystack = `${candidate.description} ${candidate.seasonHint} ${candidate.raw} ${candidate.unitLabel}`.toLowerCase();
    return haystack.includes(query);
  });

  const visibleCount = filtered.length;
  const residencyHidden = rateResidencyFilter
    ? decorated.filter(({ candidate, residency }) => {
        if (activeConfidence !== 'all' && candidate.confidence !== activeConfidence) return false;
        if (query) {
          const haystack = `${candidate.description} ${candidate.seasonHint} ${candidate.raw} ${candidate.unitLabel}`.toLowerCase();
          if (!haystack.includes(query)) return false;
        }
        return residency !== 'unknown' && residency !== wantedResidency;
      }).length
    : 0;

  dom.candidateCount.textContent = `${visibleCount} of ${all.length} rate${all.length === 1 ? '' : 's'}${rateResidencyFilter ? ` · ${wantedResidency === 'resident' ? 'Resident' : 'Non-resident'}` : ''}`;

  const filterBtn = document.getElementById('rateResidencyToggle');
  if (filterBtn) {
    filterBtn.classList.toggle('is-active', rateResidencyFilter);
    filterBtn.textContent = rateResidencyFilter
      ? `${wantedResidency === 'resident' ? 'Resident' : 'Non-resident'} only`
      : 'All guest types';
    filterBtn.title = rateResidencyFilter
      ? 'Showing rates matching the selected guest type. Click to show all rates.'
      : 'Showing all rates. Click to filter by guest type.';
  }

  if (!filtered.length) {
    const msg = rateResidencyFilter && residencyHidden
      ? `No ${wantedResidency === 'resident' ? 'resident' : 'non-resident'} rates match this filter. ${residencyHidden} other rate${residencyHidden === 1 ? '' : 's'} hidden by guest type.`
      : 'No rates match this filter. Try “All”, clear search, or show all guest types.';
    dom.candidateList.innerHTML = `<div class="supplier-empty">${escapeHtml(msg)}</div>`;
    return;
  }

  dom.candidateList.innerHTML = filtered
    .map(({ candidate, residency }) => {
      const amounts = Array.isArray(candidate.amounts) ? candidate.amounts : [];
      const labels =
        Array.isArray(candidate.amountLabels) && candidate.amountLabels.length === amounts.length
          ? candidate.amountLabels
          : amounts.map((_, index) => (amounts.length > 1 ? `Option ${index + 1}` : 'Rate'));
      const chips = amounts
        .map((amount, index) => {
          const label = labels[index] || 'Rate';
          return `<button class="amount-chip" type="button" data-cand="${escapeHtml(candidate.id)}" data-amount="${index}" title="Add to quote">
            <span>${escapeHtml(label)}</span>
            <strong>${fmtMoney(amount, candidate.currency)}</strong>
          </button>`;
        })
        .join('');
      const residencyBadge = residency !== 'unknown'
        ? ` · <span class="res-badge res-${residency}">${escapeHtml(residencyLabel(residency))}</span>`
        : '';
      return `<article class="candidate conf-${escapeHtml(candidate.confidence)}" title="${escapeHtml(candidate.raw || '')}">
        <div class="candidate-head">
          <div class="candidate-desc"><span class="confidence"></span>${escapeHtml(candidate.description)}</div>
          <span class="candidate-page">p.${escapeHtml(candidate.page)}</span>
        </div>
        <div class="candidate-meta">${escapeHtml(capitalize(candidate.confidence))} confidence · ${escapeHtml(candidate.unitLabel || 'Rate')} · ${escapeHtml(candidate.currency)}${residencyBadge}${candidate.seasonHint ? ` · ${escapeHtml(candidate.seasonHint)}` : ''}</div>
        <div class="amount-chips">${chips}</div>
      </article>`;
    })
    .join('');
}

function capitalize(value) {
  const text = String(value || '');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

function candidateResidency(candidate, file) {
  if (candidate && (candidate.residency === 'resident' || candidate.residency === 'non-resident')) {
    return candidate.residency;
  }
  const text = [
    candidate.description,
    candidate.raw,
    candidate.seasonHint,
    candidate.unitLabel,
  ]
    .filter(Boolean)
    .join(' ');
  const rowKind = residencyFromText(text);

  const fileText = [file && file.name, file && file.path, activeFile && activeFile.supplier]
    .filter(Boolean)
    .join(' ');
  const fileKind = residencyFromText(fileText);

  let pageKind = 'unknown';
  if (extraction && Array.isArray(extraction.pages)) {
    const page = extraction.pages.find((item) => Number(item.page) === Number(candidate.page));
    if (page) pageKind = residencyFromText(`${page.text || ''} ${(page.rows || []).slice(0, 8).join(' ')}`);
  }

  if (rowKind !== 'unknown') return rowKind;
  if (fileKind !== 'unknown') return fileKind;
  if (pageKind !== 'unknown') return pageKind;
  return 'unknown';
}

function residencyLabel(kind) {
  if (kind === 'resident') return 'Resident';
  if (kind === 'non-resident') return 'Non-resident';
  return 'Any';
}

function updateConfidenceButtons() {
  if (!dom.confFilter) return;
  for (const button of dom.confFilter.querySelectorAll('button')) {
    button.classList.toggle('is-active', button.dataset.conf === activeConfidence);
  }
}

function openCandidateModal(candidateId, amountIndex) {
  if (!extraction || !activeFile) return;
  const candidate = extraction.candidates.find((item) => item.id === candidateId);
  if (!candidate) return;
  const amount = candidate.amounts[amountIndex];
  if (amount === undefined) return;

  const quote = activeQuote();
  const basis = BASIS[candidate.unit] ? candidate.unit : 'per_person_night';
  const label =
    (candidate.amountLabels && candidate.amountLabels[amountIndex]) ||
    (candidate.amounts.length > 1 ? `Option ${amountIndex + 1}` : '');
  let season = candidate.seasonHint || '';
  if (label && season && !season.toLowerCase().includes(label.toLowerCase())) {
    season = `${label} · ${season}`;
  } else if (!season) {
    season = label;
  }

  openLineModal(null, {
    supplier: activeFile.supplier,
    description: candidate.description,
    basis,
    rate: amount,
    currency: CURRENCIES.includes(candidate.currency) ? candidate.currency : quote.currency,
    units: defaultUnitsFor(basis, quote),
    nights: defaultMultiplierFor(basis, quote),
    season,
    source: `${activeFile.file.name} · page ${candidate.page}`,
    notes: '',
  });
}

/* --------------------------------------------------------------------------
   Settings rendering
--------------------------------------------------------------------------- */

function renderSettings() {
  const settings = state.settings;
  const company = settings.company || {};
  dom.companyName.value = company.name || '';
  dom.companyTagline.value = company.tagline || '';
  dom.preparedBy.value = company.preparedBy || '';
  dom.companyEmail.value = company.email || '';
  dom.companyPhone.value = company.phone || '';
  dom.defaultMarkup.value = settings.defaultMarkup;
  dom.defaultCurrency.value = settings.defaultCurrency;
  dom.fxUsd.value = settings.fx.USD;
  dom.fxKes.value = settings.fx.KES;
  dom.fxEur.value = settings.fx.EUR;
  dom.fxGbp.value = settings.fx.GBP;
  dom.shareUrl.value = settings.shareUrl || (inventory && inventory.shareUrl) || DEFAULT_SHARE_URL;
}

/* --------------------------------------------------------------------------
   Line editor
--------------------------------------------------------------------------- */

function openLineModal(line = null, prefill = null) {
  const quote = activeQuote();
  editingLineId = line ? line.id : null;
  const requestedBasis = (line && line.basis) || (prefill && prefill.basis) || 'per_person_night';
  const basis = BASIS[requestedBasis] ? requestedBasis : 'per_person_night';

  dom.lineModalEyebrow.textContent = (line && line.source) || (prefill && prefill.source)
    ? 'From contract'
    : 'Itinerary line';
  dom.lineModalTitle.textContent = line ? 'Edit line' : 'Add a line';
  dom.lineId.value = line ? line.id : '';
  dom.lineSupplier.value = (line && line.supplier) || (prefill && prefill.supplier) || '';
  dom.lineDescription.value = (line && line.description) || (prefill && prefill.description) || '';
  dom.lineBasis.value = basis;
  dom.lineRate.value =
    line && line.rate !== undefined && line.rate !== null
      ? line.rate
      : prefill && prefill.rate !== undefined && prefill.rate !== null
        ? prefill.rate
        : '';
  dom.lineCurrency.value =
    (line && line.currency) || (prefill && prefill.currency) || quote.currency;
  dom.lineSeason.value = (line && line.season) || (prefill && prefill.season) || '';
  dom.lineNotes.value = (line && line.notes) || (prefill && prefill.notes) || '';
  dom.lineMarkup.value =
    line && line.markup !== null && line.markup !== undefined ? line.markup : '';
  dom.lineSource.value = (line && line.source) || (prefill && prefill.source) || '';
  dom.lineSourceWrap.classList.toggle('hidden', !dom.lineSource.value);
  dom.lineDeleteBtn.classList.toggle('hidden', !line);

  syncBasisFields(basis, {
    units: line ? line.units : prefill ? prefill.units : undefined,
    nights: line ? line.nights : prefill ? prefill.nights : undefined,
  });

  dom.lineModal.classList.remove('hidden');
  document.body.classList.add('modal-open');
  updateLinePreview();
  setTimeout(() => dom.lineDescription.focus(), 50);
}

function closeLineModal() {
  dom.lineModal.classList.add('hidden');
  document.body.classList.remove('modal-open');
  editingLineId = null;
}

function syncBasisFields(basisKey, values = {}, reset = false) {
  const quote = activeQuote();
  const definition = basisDefinition(basisKey);
  dom.lineUnitsLabel.textContent = definition.unitsLabel;

  if (definition.multiplier) {
    dom.lineMultiplierWrap.classList.remove('hidden');
    dom.lineMultiplierLabel.textContent = definition.multiplier === 'days' ? 'Days' : 'Nights';
    if (reset) dom.lineMultiplier.value = defaultMultiplierFor(basisKey, quote);
    else if (values.nights !== undefined && values.nights !== null) dom.lineMultiplier.value = values.nights;
    else if (dom.lineMultiplier.value === '') dom.lineMultiplier.value = defaultMultiplierFor(basisKey, quote);
  } else {
    dom.lineMultiplierWrap.classList.add('hidden');
    dom.lineMultiplier.value = 1;
  }

  if (reset) dom.lineUnits.value = defaultUnitsFor(basisKey, quote);
  else if (values.units !== undefined && values.units !== null) dom.lineUnits.value = values.units;
  else if (dom.lineUnits.value === '') dom.lineUnits.value = defaultUnitsFor(basisKey, quote);

  updateLinePreview();
}

function updateLinePreview() {
  if (!dom.linePreview) return;
  const quote = activeQuote();
  const basisKey = dom.lineBasis.value;
  const definition = basisDefinition(basisKey);
  const units = Math.max(0, num(dom.lineUnits.value, defaultUnitsFor(basisKey, quote)));
  const multiplier = definition.multiplier
    ? Math.max(0, num(dom.lineMultiplier.value, 1))
    : 1;
  const rate = Math.max(0, num(dom.lineRate.value, 0));
  const currency = CURRENCIES.includes(dom.lineCurrency.value)
    ? dom.lineCurrency.value
    : quote.currency;
  const markupText = dom.lineMarkup.value.trim();
  const markupPercent =
    markupText === '' ? Math.max(0, num(quote.markup, 0)) : Math.max(0, num(markupText, 0));
  const net = rate * units * multiplier;
  const netQuote = convertCurrency(net, currency, quote.currency);
  const markup = netQuote * (markupPercent / 100);
  const sell = netQuote + markup;
  const unitsLabel = `${fmtAmount(units)} ${unitWord(definition.unitsLabel, units)}`;
  const multiplierLabel = definition.multiplier
    ? ` × ${fmtAmount(multiplier)} ${definition.multiplier}`
    : '';
  const conversion =
    currency !== quote.currency
      ? ` <span class="preview-muted">→ ${escapeHtml(quote.currency)}</span>`
      : '';

  dom.linePreview.innerHTML = `
    <span class="preview-muted">${fmtMoney(rate, currency)} × ${escapeHtml(unitsLabel)}${escapeHtml(multiplierLabel)}${conversion}</span>
    <span>Net <strong>${fmtMoney(netQuote, quote.currency)}</strong></span>
    <span class="preview-muted">Markup ${fmtAmount(markupPercent)}% → ${fmtMoney(markup, quote.currency)}</span>
    <span class="preview-sell">Sell ${fmtMoney(sell, quote.currency)}</span>`;
}

function saveLineFromForm(event) {
  event.preventDefault();
  const quote = activeQuote();
  const wasEditing = Boolean(editingLineId);
  const description = dom.lineDescription.value.trim();
  if (!description) {
    toast('Add a service description.', 'error');
    dom.lineDescription.focus();
    return;
  }
  if (dom.lineRate.value.trim() === '') {
    toast('Enter the net rate.', 'error');
    dom.lineRate.focus();
    return;
  }

  const basis = BASIS[dom.lineBasis.value] ? dom.lineBasis.value : 'per_person_night';
  const definition = basisDefinition(basis);
  const line = {
    id: editingLineId || uid('line'),
    supplier: dom.lineSupplier.value.trim(),
    description,
    basis,
    rate: Math.max(0, num(dom.lineRate.value, 0)),
    currency: CURRENCIES.includes(dom.lineCurrency.value)
      ? dom.lineCurrency.value
      : quote.currency,
    units: Math.max(0, num(dom.lineUnits.value, defaultUnitsFor(basis, quote))),
    nights: definition.multiplier
      ? Math.max(0, num(dom.lineMultiplier.value, 1))
      : 1,
    markup:
      dom.lineMarkup.value.trim() === ''
        ? null
        : clamp(num(dom.lineMarkup.value, 0), 0, 100),
    season: dom.lineSeason.value.trim(),
    notes: dom.lineNotes.value.trim(),
    source: dom.lineSource.value.trim(),
  };

  if (wasEditing) {
    const index = quote.lines.findIndex((item) => item.id === editingLineId);
    if (index >= 0) quote.lines[index] = line;
    else quote.lines.push(line);
  } else {
    quote.lines.push(line);
  }

  touchQuote(quote);
  saveState();
  closeLineModal();
  renderLines();
  renderSummary();
  renderQuoteSelect();

  if (wasEditing) {
    toast('Line updated.');
  } else {
    toast(
      `Added “${line.description}” to ${quote.name}.`,
      'info',
      activeView === 'rates'
        ? { label: 'View quote', onClick: () => showView('quote') }
        : null
    );
  }
}

function deleteEditingLine() {
  if (!editingLineId) return;
  const quote = activeQuote();
  const index = quote.lines.findIndex((line) => line.id === editingLineId);
  if (index < 0) {
    closeLineModal();
    return;
  }
  if (!confirm('Delete this line?')) return;
  quote.lines.splice(index, 1);
  touchQuote(quote);
  saveState();
  closeLineModal();
  renderLines();
  renderSummary();
  renderQuoteSelect();
  toast('Line deleted.');
}

function handleLineAction(action, lineId) {
  const quote = activeQuote();
  const index = quote.lines.findIndex((line) => line.id === lineId);
  if (index < 0) return;
  const line = quote.lines[index];

  if (action === 'edit') {
    openLineModal(line);
    return;
  }
  if (action === 'duplicate') {
    const copy = { ...line, id: uid('line') };
    quote.lines.splice(index + 1, 0, copy);
    touchQuote(quote);
    saveState();
    renderLines();
    renderSummary();
    toast('Line duplicated.');
    return;
  }
  if (action === 'up' && index > 0) {
    [quote.lines[index - 1], quote.lines[index]] = [quote.lines[index], quote.lines[index - 1]];
  } else if (action === 'down' && index < quote.lines.length - 1) {
    [quote.lines[index + 1], quote.lines[index]] = [quote.lines[index], quote.lines[index + 1]];
  } else if (action === 'delete') {
    if (!confirm('Delete this line?')) return;
    quote.lines.splice(index, 1);
  } else {
    return;
  }

  touchQuote(quote);
  saveState();
  renderLines();
  renderSummary();
}

function openManualLine(prefill = {}) {
  const quote = activeQuote();
  openLineModal(null, {
    basis: 'per_person_night',
    currency: quote.currency,
    units: defaultUnitsFor('per_person_night', quote),
    nights: defaultMultiplierFor('per_person_night', quote),
    ...prefill,
  });
}

/* --------------------------------------------------------------------------
   CSV import / export
--------------------------------------------------------------------------- */

function normalizeHeader(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function parseCsv(text) {
  const source = String(text == null ? '' : text).replace(/^\ufeff/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inQuotes) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += character;
      }
    } else if (character === '"') {
      inQuotes = true;
    } else if (character === ',') {
      row.push(cell);
      cell = '';
    } else if (character === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (character !== '\r') {
      cell += character;
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function findHeaderIndex(header, names) {
  for (const name of names) {
    const key = normalizeHeader(name);
    if (Object.prototype.hasOwnProperty.call(header, key)) return header[key];
    for (const [headerKey, index] of Object.entries(header)) {
      if (headerKey === key) return index;
      if (headerKey.startsWith(`${key} `)) {
        const suffix = headerKey.slice(key.length + 1);
        if (!suffix.startsWith('basis') && !suffix.startsWith('type')) return index;
      }
    }
  }
  return -1;
}

function getCsvCell(row, header, names) {
  const index = findHeaderIndex(header, names);
  return index >= 0 ? String(row[index] == null ? '' : row[index]).trim() : '';
}

function parseNumber(value) {
  const cleaned = String(value == null ? '' : value)
    .replace(/,/g, '')
    .replace(/[^0-9.+-]/g, '');
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function findBasis(value) {
  const raw = String(value == null ? '' : value).trim();
  if (BASIS[raw]) return raw;
  const key = normalizeHeader(raw);
  for (const [basisKey, definition] of Object.entries(BASIS)) {
    if (normalizeHeader(basisKey) === key || normalizeHeader(definition.label) === key) {
      return basisKey;
    }
  }
  if (key.includes('child')) return key.includes('night') ? 'per_child_night' : 'per_child';
  if (key.includes('room') || key.includes('suite') || key.includes('tent') || key.includes('villa')) {
    return key.includes('night') ? 'per_room_night' : 'per_person';
  }
  if (key.includes('vehicle') || key.includes('car') || key.includes('van')) {
    return key.includes('day') ? 'per_vehicle_day' : 'per_vehicle';
  }
  if (key.includes('group') || key.includes('flat') || key.includes('booking')) {
    return key.includes('day') ? 'per_group_day' : 'per_group';
  }
  if (key.includes('per person') || key.includes('person')) {
    if (key.includes('night')) return 'per_person_night';
    if (key.includes('day')) return 'per_person_day';
    return 'per_person';
  }
  if (key.includes('night')) return 'per_room_night';
  if (key.includes('day')) return 'per_group_day';
  return 'per_person_night';
}

function importCsv(text) {
  const rows = parseCsv(text).filter((row) => row.some((cell) => String(cell).trim() !== ''));
  if (rows.length < 2) {
    toast('That CSV is empty.', 'error');
    return;
  }

  const headerRow = rows[0];
  const header = {};
  headerRow.forEach((cell, index) => {
    const key = normalizeHeader(String(cell).replace(/^\ufeff/, ''));
    if (key) header[key] = index;
  });

  const descriptionKeys = ['description', 'service', 'service description', 'item', 'line item', 'details', 'itinerary'];
  const rateKeys = ['rate', 'net rate', 'net', 'price', 'cost', 'amount', 'unit rate'];
  if (findHeaderIndex(header, descriptionKeys) < 0 || findHeaderIndex(header, rateKeys) < 0) {
    toast('CSV needs a header row with at least Description and Rate columns.', 'error');
    return;
  }

  const quote = activeQuote();
  const supplierKeys = ['supplier', 'vendor', 'property', 'camp', 'lodging'];
  const basisKeys = ['basis', 'rate basis', 'unit basis', 'type'];
  const unitsKeys = ['units', 'qty', 'quantity', 'pax', 'number of', 'people'];
  const nightsKeys = ['nights days', 'nights/days', 'nights', 'days', 'duration', 'multiplier'];
  const currencyKeys = ['currency', 'cur', 'ccy'];
  const markupKeys = ['markup', 'mark up', 'markup percent', 'markup pct', 'markup %'];
  const seasonKeys = ['season', 'validity', 'period', 'dates', 'date range'];
  const notesKeys = ['notes', 'note', 'remarks', 'comments'];
  const sourceKeys = ['source', 'file', 'contract', 'document'];

  const lines = [];
  for (const row of rows.slice(1)) {
    const description = getCsvCell(row, header, descriptionKeys);
    const rateText = getCsvCell(row, header, rateKeys);
    if (!description && !rateText) continue;

    const basis = findBasis(getCsvCell(row, header, basisKeys));
    const definition = basisDefinition(basis);
    const unitsText = getCsvCell(row, header, unitsKeys);
    const nightsText = getCsvCell(row, header, nightsKeys);
    const markupText = getCsvCell(row, header, markupKeys);
    const currencyText = getCsvCell(row, header, currencyKeys).toUpperCase();

    lines.push({
      id: uid('line'),
      supplier: getCsvCell(row, header, supplierKeys),
      description: description || 'Imported service',
      basis,
      rate: Math.max(0, parseNumber(rateText)),
      currency: CURRENCIES.includes(currencyText) ? currencyText : quote.currency,
      units: unitsText
        ? Math.max(0, parseNumber(unitsText))
        : defaultUnitsFor(basis, quote),
      nights: definition.multiplier
        ? nightsText
          ? Math.max(0, parseNumber(nightsText))
          : defaultMultiplierFor(basis, quote)
        : 1,
      markup: markupText ? clamp(parseNumber(markupText), 0, 100) : null,
      season: getCsvCell(row, header, seasonKeys),
      notes: getCsvCell(row, header, notesKeys),
      source: getCsvCell(row, header, sourceKeys),
    });
  }

  if (!lines.length) {
    toast('No rows with a description and rate were found.', 'error');
    return;
  }

  const replace = confirm(
    `Import ${lines.length} line${lines.length === 1 ? '' : 's'}?\n\nOK replaces the current itinerary. Cancel appends to it.`
  );
  if (replace) quote.lines = lines;
  else quote.lines = quote.lines.concat(lines);

  touchQuote(quote);
  saveState(true);
  renderLines();
  renderSummary();
  renderQuoteSelect();
  toast(`Imported ${lines.length} line${lines.length === 1 ? '' : 's'}.`);
}

function csvCell(value) {
  const text = String(value == null ? '' : value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportCsv() {
  const quote = activeQuote();
  const rows = [
    [
      'Supplier',
      'Description',
      'Basis',
      'Units',
      'Nights/Days',
      'Rate',
      'Currency',
      'Markup %',
      `Net (${quote.currency})`,
      `Sell (${quote.currency})`,
      'Season',
      'Notes',
      'Source',
    ],
  ];
  for (const line of quote.lines) {
    const calc = computeLine(line, quote);
    rows.push([
      line.supplier,
      line.description,
      line.basis,
      calc.units,
      calc.multiplier,
      line.rate,
      line.currency,
      calc.markupPercent,
      calc.netQuote.toFixed(2),
      calc.sell.toFixed(2),
      line.season,
      line.notes,
      line.source,
    ]);
  }
  const csv = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
  downloadFile(`\ufeff${csv}`, `${safeFilename(quote.name)}.csv`, 'text/csv;charset=utf-8');
  toast('CSV exported.');
}

function safeFilename(value) {
  return (
    String(value || 'quote')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 80) || 'quote'
  );
}

function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/* --------------------------------------------------------------------------
   Backup
--------------------------------------------------------------------------- */

function exportBackup() {
  downloadFile(
    JSON.stringify(state, null, 2),
    `safari-quote-backup-${nowIso().slice(0, 10)}.json`,
    'application/json'
  );
  toast('Backup exported.');
}

async function restoreBackup(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.quotes)) {
      throw new Error('That file is not a Safari Quote backup.');
    }
    if (!confirm('Replace all current quotes and settings with this backup?')) return;
    state = normalizeState(data);
    saveState(true);
    renderSettings();
    renderAll();
    showView('quote');
    toast('Backup restored.');
  } catch (error) {
    toast(`Could not restore backup: ${error.message}`, 'error');
  }
}

/* --------------------------------------------------------------------------
   Quote actions
--------------------------------------------------------------------------- */

function newQuote() {
  const name = window.prompt('Name for the new quote:', 'New itinerary');
  if (name === null) return;
  const quote = createQuote(name.trim() || 'New itinerary');
  state.quotes.push(quote);
  state.activeId = quote.id;
  saveState(true);
  renderAll();
  showView('quote');
  toast('New quote created.');
}

function duplicateQuote() {
  const source = activeQuote();
  const copy = JSON.parse(JSON.stringify(source));
  copy.id = uid('quote');
  copy.name = `${source.name} copy`;
  copy.createdAt = nowIso();
  copy.updatedAt = nowIso();
  copy.lines = (copy.lines || []).map((line) => ({ ...line, id: uid('line') }));
  const index = state.quotes.findIndex((quote) => quote.id === state.activeId);
  state.quotes.splice(Math.max(0, index + 1), 0, copy);
  state.activeId = copy.id;
  saveState(true);
  renderAll();
  showView('quote');
  toast('Quote duplicated.');
}

function deleteQuote() {
  const index = state.quotes.findIndex((quote) => quote.id === state.activeId);
  const quote = activeQuote();
  if (!confirm(`Delete “${quote.name}”?`)) return;
  state.quotes.splice(index, 1);
  if (!state.quotes.length) state.quotes.push(createQuote('Kenya itinerary'));
  state.activeId = state.quotes[Math.max(0, Math.min(index, state.quotes.length - 1))].id;
  saveState(true);
  renderAll();
  showView('quote');
  toast('Quote deleted.');
}

function resetAll() {
  if (
    !confirm(
      'Delete all quotes and settings from this browser?\n\nExport a backup first if you need it.'
    )
  ) {
    return;
  }
  state = normalizeState(null);
  saveState(true);
  renderSettings();
  renderAll();
  showView('quote');
  toast('All quotes cleared.');
}

/* --------------------------------------------------------------------------
   Events
--------------------------------------------------------------------------- */

function bindEvents() {
  for (const button of dom.navItems) {
    button.addEventListener('click', () => showView(button.dataset.view));
  }

  dom.syncBtn.addEventListener('click', syncLibrary);
  dom.settingsSyncBtn.addEventListener('click', syncLibrary);

  dom.quoteSelect.addEventListener('change', () => {
    const id = dom.quoteSelect.value;
    if (!state.quotes.some((quote) => quote.id === id)) return;
    state.activeId = id;
    saveState(true);
    renderAll();
    showView('quote');
  });
  dom.newQuoteBtn.addEventListener('click', newQuote);
  dom.duplicateQuoteBtn.addEventListener('click', duplicateQuote);
  dom.deleteQuoteBtn.addEventListener('click', deleteQuote);

  dom.importBtn.addEventListener('click', () => dom.csvFile.click());
  dom.exportBtn.addEventListener('click', exportCsv);
  dom.printBtn.addEventListener('click', printQuote);
  dom.sidePrintBtn.addEventListener('click', printQuote);

  dom.quoteName.addEventListener('input', () => {
    const quote = activeQuote();
    quote.name = dom.quoteName.value;
    touchQuote(quote);
    renderQuoteSelect();
    saveState();
  });

  dom.clientName.addEventListener('input', () => {
    const quote = activeQuote();
    quote.client = dom.clientName.value;
    touchQuote(quote);
    renderQuoteSelect();
    saveState();
  });

  dom.destination.addEventListener('input', () => {
    const quote = activeQuote();
    quote.destination = dom.destination.value;
    touchQuote(quote);
    saveState();
  });

  dom.startDate.addEventListener('input', () => {
    const quote = activeQuote();
    quote.startDate = dom.startDate.value;
    touchQuote(quote);
    saveState();
  });

  dom.endDate.addEventListener('input', () => {
    const quote = activeQuote();
    quote.endDate = dom.endDate.value;
    touchQuote(quote);
    saveState();
  });

  dom.adults.addEventListener('input', () => {
    const quote = activeQuote();
    quote.adults = Math.max(0, Math.round(num(dom.adults.value, 0)));
    touchQuote(quote);
    renderSummary();
    saveState();
  });

  dom.children.addEventListener('input', () => {
    const quote = activeQuote();
    quote.children = Math.max(0, Math.round(num(dom.children.value, 0)));
    touchQuote(quote);
    renderSummary();
    saveState();
  });

  dom.tripDays.addEventListener('input', () => {
    const quote = activeQuote();
    quote.tripDays = Math.max(1, Math.round(num(dom.tripDays.value, 1)));
    touchQuote(quote);
    renderPlanner();
    saveState();
  });

  dom.residency.addEventListener('change', () => {
    const quote = activeQuote();
    quote.residency = dom.residency.value === 'resident' ? 'resident' : 'non-resident';
    touchQuote(quote);
    renderHotelMatches();
    if (extraction) renderCandidates();
    saveState();
  });

  dom.addStopBtn.addEventListener('click', () => {
    const quote = activeQuote();
    const stop = createStop('', 1);
    quote.stops.push(stop);
    activeStopId = stop.id;
    syncTripDays(quote);
    touchQuote(quote);
    renderPlanner();
    saveState();
    const input = dom.stopsList.querySelector(`[data-stop-id="${stop.id}"][data-stop-field="location"]`);
    if (input) input.focus();
  });

  dom.stopsList.addEventListener('input', (event) => {
    const field = event.target.dataset.stopField;
    const stopId = event.target.dataset.stopId;
    if (!field || !stopId) return;
    const quote = activeQuote();
    const stop = quote.stops.find((item) => item.id === stopId);
    if (!stop) return;
    activeStopId = stopId;
    if (field === 'location') stop.location = event.target.value;
    if (field === 'nights') stop.nights = Math.max(1, Math.round(num(event.target.value, 1)));
    syncTripDays(quote);
    touchQuote(quote);
    renderPlanner();
    saveState();
  });

  dom.stopsList.addEventListener('focusin', (event) => {
    const row = event.target.closest('.stop-row');
    if (!row) return;
    if (activeStopId !== row.dataset.stopId) {
      activeStopId = row.dataset.stopId;
      renderHotelMatches();
      for (const item of dom.stopsList.querySelectorAll('.stop-row')) {
        item.classList.toggle('is-active', item.dataset.stopId === activeStopId);
      }
    }
  });

  dom.stopsList.addEventListener('click', (event) => {
    const removeBtn = event.target.closest('[data-stop-remove]');
    if (!removeBtn) return;
    const quote = activeQuote();
    if (quote.stops.length <= 1) return;
    const stopId = removeBtn.dataset.stopRemove;
    quote.stops = quote.stops.filter((stop) => stop.id !== stopId);
    if (activeStopId === stopId) activeStopId = quote.stops[0].id;
    syncTripDays(quote);
    touchQuote(quote);
    renderPlanner();
    saveState();
  });

  dom.hotelMatchList.addEventListener('click', (event) => {
    const fileBtn = event.target.closest('[data-open-supplier][data-open-file]');
    const browseBtn = event.target.closest('[data-browse-supplier]');
    if (fileBtn) {
      openSupplierFile(fileBtn.dataset.openSupplier, Number(fileBtn.dataset.openFile));
      return;
    }
    if (browseBtn) {
      openSupplierInRates(browseBtn.dataset.browseSupplier);
    }
  });

  dom.quoteCurrency.addEventListener('change', () => {
    const quote = activeQuote();
    quote.currency = CURRENCIES.includes(dom.quoteCurrency.value)
      ? dom.quoteCurrency.value
      : 'USD';
    touchQuote(quote);
    saveState(true);
    renderLines();
    renderSummary();
  });

  dom.markupInput.addEventListener('input', () => {
    const quote = activeQuote();
    quote.markup = clamp(num(dom.markupInput.value, 0), 0, 100);
    touchQuote(quote);
    renderLines();
    renderSummary();
    saveState();
  });

  dom.quoteNotes.addEventListener('input', () => {
    const quote = activeQuote();
    quote.notes = dom.quoteNotes.value;
    touchQuote(quote);
    saveState();
  });

  dom.addManualLineBtn.addEventListener('click', () => openManualLine());
  dom.emptyManualBtn.addEventListener('click', () => openManualLine());
  dom.browseRatesBtn.addEventListener('click', () => showView('rates'));
  dom.emptyBrowseBtn.addEventListener('click', () => showView('rates'));

  dom.linesBody.addEventListener('click', (event) => {
    const button = event.target.closest('[data-line-action]');
    if (!button) return;
    handleLineAction(button.dataset.lineAction, button.dataset.lineId);
  });

  dom.rateSearch.addEventListener('input', () => {
    clearTimeout(supplierSearchTimer);
    supplierSearchTimer = setTimeout(() => renderSuppliers({ resetScroll: true }), 120);
  });

  dom.rateExtFilter.addEventListener('change', () => renderSuppliers({ resetScroll: true }));

  dom.supplierList.addEventListener('click', (event) => {
    const button = event.target.closest('.file-item');
    if (!button) return;
    selectFile(Number(button.dataset.supplierIndex), Number(button.dataset.fileIndex));
  });

  dom.rateOpen.addEventListener('click', (event) => {
    if (!serverOnline) {
      event.preventDefault();
      toast('Start the local server to open contract files.', 'error');
    }
  });

  dom.rateExtractBtn.addEventListener('click', extractActiveFile);
  dom.manualFromFileBtn.addEventListener('click', () => {
    if (!activeFile) return;
    openManualLine({
      supplier: activeFile.supplier,
      source: activeFile.file.name,
    });
  });

  dom.confFilter.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-conf]');
    if (!button) return;
    activeConfidence = button.dataset.conf;
    updateConfidenceButtons();
    renderCandidates();
  });

  const residencyToggle = document.getElementById('rateResidencyToggle');
  if (residencyToggle) {
    residencyToggle.addEventListener('click', () => {
      rateResidencyFilter = !rateResidencyFilter;
      renderCandidates();
    });
  }

  dom.candidateSearch.addEventListener('input', renderCandidates);

  dom.candidateList.addEventListener('click', (event) => {
    const chip = event.target.closest('.amount-chip');
    if (!chip) return;
    openCandidateModal(chip.dataset.cand, Number(chip.dataset.amount));
  });

  dom.rateImage.addEventListener('error', () => dom.rateImageWrap.classList.add('hidden'));

  const companyFields = [
    ['companyName', 'name'],
    ['companyTagline', 'tagline'],
    ['preparedBy', 'preparedBy'],
    ['companyEmail', 'email'],
    ['companyPhone', 'phone'],
  ];
  for (const [id, field] of companyFields) {
    dom[id].addEventListener('input', () => {
      state.settings.company[field] = dom[id].value;
      saveState();
    });
  }

  dom.defaultMarkup.addEventListener('input', () => {
    state.settings.defaultMarkup = clamp(num(dom.defaultMarkup.value, 0), 0, 100);
    saveState();
  });

  dom.defaultCurrency.addEventListener('change', () => {
    if (CURRENCIES.includes(dom.defaultCurrency.value)) {
      state.settings.defaultCurrency = dom.defaultCurrency.value;
      saveState();
    }
  });

  const fxFields = [
    ['fxUsd', 'USD'],
    ['fxKes', 'KES'],
    ['fxEur', 'EUR'],
    ['fxGbp', 'GBP'],
  ];
  for (const [id, code] of fxFields) {
    dom[id].addEventListener('input', () => {
      const value = Math.max(0.0001, num(dom[id].value, DEFAULT_FX[code]));
      state.settings.fx[code] = value;
      saveState();
      renderLines();
      renderSummary();
      if (!dom.lineModal.classList.contains('hidden')) updateLinePreview();
    });
    dom[id].addEventListener('change', () => {
      dom[id].value = state.settings.fx[code];
    });
  }

  dom.shareUrl.addEventListener('input', () => {
    state.settings.shareUrl = dom.shareUrl.value.trim();
    saveState();
    dom.contractLink.href = state.settings.shareUrl || DEFAULT_SHARE_URL;
  });

  dom.exportBackupBtn.addEventListener('click', exportBackup);
  dom.importBackupBtn.addEventListener('click', () => dom.backupFile.click());
  dom.backupFile.addEventListener('change', async () => {
    const file = dom.backupFile.files && dom.backupFile.files[0];
    dom.backupFile.value = '';
    if (!file) return;
    await restoreBackup(file);
  });
  dom.resetBtn.addEventListener('click', resetAll);

  dom.lineForm.addEventListener('submit', saveLineFromForm);
  dom.lineBasis.addEventListener('change', () => {
    syncBasisFields(dom.lineBasis.value, {}, true);
  });
  for (const id of ['lineUnits', 'lineMultiplier', 'lineRate', 'lineCurrency', 'lineMarkup']) {
    dom[id].addEventListener('input', updateLinePreview);
    dom[id].addEventListener('change', updateLinePreview);
  }
  dom.lineDeleteBtn.addEventListener('click', deleteEditingLine);

  for (const button of document.querySelectorAll('[data-close]')) {
    button.addEventListener('click', closeLineModal);
  }
  dom.lineModal.addEventListener('click', (event) => {
    if (event.target === dom.lineModal) closeLineModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !dom.lineModal.classList.contains('hidden')) {
      closeLineModal();
    }
  });

  dom.csvFile.addEventListener('change', async () => {
    const file = dom.csvFile.files && dom.csvFile.files[0];
    dom.csvFile.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      importCsv(text);
    } catch (error) {
      toast(`Could not read that CSV: ${error.message}`, 'error');
    }
  });

  window.addEventListener('beforeunload', () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      /* ignore quota errors on unload */
    }
  });
}

/* --------------------------------------------------------------------------
   Start
--------------------------------------------------------------------------- */

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}




