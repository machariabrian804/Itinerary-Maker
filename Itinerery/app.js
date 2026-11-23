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
    multDefault: (q) => quoteDays(q),
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
    multDefault: (q) => quoteDays(q),
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
    multDefault: (q) => quoteDays(q),
  },
  per_day: {
    label: 'Per day (flat)',
    unitsLabel: 'Groups',
    multiplier: 'days',
    unitDefault: () => 1,
    multDefault: (q) => quoteDays(q),
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
  if (quote && quote.startDate && quote.endDate) {
    const start = new Date(`${quote.startDate}T00:00:00`);
    const end = new Date(`${quote.endDate}T00:00:00`);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
      const nights = Math.round((end.getTime() - start.getTime()) / 86400000);
      return Math.max(1, nights);
    }
  }
  if (quote && Array.isArray(quote.stops)) {
    const stopNights = quote.stops.reduce(
      (sum, stop) => sum + Math.max(0, Math.round(num(stop.nights, 0))),
      0
    );
    if (stopNights > 0) return stopNights;
  }
  return 1;
}

function quoteDays(quote) {
  if (!quote) return 1;
  const days = Math.round(num(quote.tripDays, 0));
  if (Number.isFinite(days) && days >= 1) return days;
  return Math.max(1, quoteNights(quote) + 1);
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
    'residency',
    'plannerDays',
    'plannerDaysPlural',
    'plannerNights',
    'plannerNightsPlural',
    'addStopBtn',
    'stopsList',
    'hotelMatchesHint',
    'hotelMatchList',
    'frameworkPlanner',
    'frameworkDays',
    'frameworkSeason',
    'frameworkTier',
    'frameworkBudget',
    'frameworkCurrencyLabel',
    'frameworkBuildBtn',
    'frameworkStatus',
    'frameworkStatusText',
    'frameworkResult',
    'frameworkAreaChips',
    'frameworkAreaHint',
    'frameworkSuggestBtn',
    'frameworkNightPill',
    'frameworkAreaPill',
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
    'rateLocationFilter',
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
  populateLocationFilter();
  populateAreaChips();
  initFrameworkAreas(activeQuote());
  populateAreaChips();
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
  if (dom.frameworkBuildBtn) dom.frameworkBuildBtn.disabled = frameworkState.busy || !serverOnline;
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
    supplierAreaCache.clear();
    if (inventory.shareUrl) state.settings.shareUrl = inventory.shareUrl;
    saveState(true);
    updateServerUI();
    populateLocationFilter();
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

function activeStopNights(quote = activeQuote()) {
  const stop = ensureActiveStop(quote);
  return Math.max(1, Math.round(num(stop.nights, 1)));
}

function syncTripDays(quote = activeQuote()) {
  const days = Math.round(num(quote.tripDays, 0));
  if (!Number.isFinite(days) || days < 1) {
    quote.tripDays = Math.max(1, totalNights(quote) + 1);
  }
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
  const requested = detectAreaFromText(stop.location);
  const decorated = inventory.suppliers.map((supplier) => {
    const area = detectSupplierArea(supplier);
    let score = scoreSupplierForStop(supplier, stop, residency);
    if (requested && area.key === requested.key) score += 5;
    return { supplier, area, score };
  });
  return decorated
    .filter((item) => item.score > 0)
    .sort(
      (a, b) =>
        a.area.label.localeCompare(b.area.label) ||
        b.score - a.score ||
        a.supplier.name.localeCompare(b.supplier.name)
    )
    .slice(0, 18);
}

/* --------------------------------------------------------------------------
   Locations — every hotel is filed under the area it serves
--------------------------------------------------------------------------- */

const AREA_CATALOG = [
  {
    key: 'mara',
    label: 'Masai Mara',
    patterns: [
      'masai mara', 'maasai mara', 'mara', 'talek', 'ol kiombo', 'sek enani', 'olare',
      'keekorok', 'musiara', 'siana', 'lemek', 'aitong', 'mara river', 'mara north',
      'mara conservancy', 'mara triangle', 'mara rip' ,'rip oi',
    ],
  },
  {
    key: 'amboseli',
    label: 'Amboseli',
    patterns: ['amboseli', 'kimana', 'tortilis', 'ol tukai', 'sinet', 'chylu', 'kajiado'],
  },
  {
    key: 'naivasha',
    label: 'Naivasha',
    patterns: [
      'naivasha', 'lake naivasha', 'hells gate', 'hell gate', 'longonot', 'kigio',
      'sawela', 'elmer', 'morendat', 'great rift',
    ],
  },
  {
    key: 'nakuru',
    label: 'Nakuru / Elementaita',
    patterns: ['nakuru', 'bogoria', 'elementaita', 'lake nakuru', 'lake elementaita'],
  },
  {
    key: 'nairobi',
    label: 'Nairobi',
    patterns: [
      'nairobi', 'nbo', 'karen', 'upperhill', 'westlands', 'jkia', 'wilson', 'gigiri',
      'lavington', 'kilimani', 'parklands', 'villa rosa', 'norfolk', 'westwood',
    ],
  },
  {
    key: 'diani',
    label: 'Diani / South Coast',
    patterns: ['diani', 'ukunda', 'south coast', 'msambweni', 'galu', 'tiwi', 'chale'],
  },
  {
    key: 'mombasa',
    label: 'Mombasa',
    patterns: ['mombasa', 'nyali', 'bamburi', 'shanzu', 'mombasa reef', 'serena beach'],
  },
  {
    key: 'watamu',
    label: 'Watamu / Malindi',
    patterns: ['watamu', 'malindi', 'kilifi', 'vipingo', 'casuarina', 'marijani'],
  },
  {
    key: 'lamu',
    label: 'Lamu',
    patterns: ['lamu', 'manda', 'shella', 'peponi'],
  },
  {
    key: 'samburu',
    label: 'Samburu',
    patterns: ['samburu', 'shaba', 'buffalo springs', 'archers post', 'kalama'],
  },
  {
    key: 'laikipia',
    label: 'Laikipia / Ol Pejeta',
    patterns: [
      'laikipia', 'ol pejeta', 'olpejeta', 'sweetwaters', 'lewa', 'borana', 'segera',
      'nanyuki', 'loisaba', 'suyian', 'maasai land', 'ol jogi', 'oljogi',
    ],
  },
  {
    key: 'tsavo',
    label: 'Tsavo / Taita Hills',
    patterns: ['tsavo', 'taita', 'voi', 'salt lick', 'saltlick', 'kilaguni', 'ngutuni', 'manyatta'],
  },
  {
    key: 'meru',
    label: 'Meru',
    patterns: ['meru', 'kisampa', 'murera'],
  },
  {
    key: 'mtkenya',
    label: 'Mount Kenya',
    patterns: ['mount kenya', 'mt kenya', 'serena mountain', 'timau', 'naromoru', 'naro moru'],
  },
  {
    key: 'western',
    label: 'Western Kenya',
    patterns: ['kisumu', 'kakamega', 'kisii', 'siaya', 'mbita', 'rusinga', 'kisumu impala'],
  },
];

const OTHER_AREA = { key: 'other', label: 'Multi-property / other', score: 0 };
const supplierAreaCache = new Map();

function areaRegex(pattern) {
  return new RegExp(`\\b${String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
}

function detectAreaFromText(text) {
  const value = String(text || '').toLowerCase();
  if (!value.trim()) return null;
  let best = null;
  for (const area of AREA_CATALOG) {
    for (const pattern of area.patterns) {
      if (!areaRegex(pattern).test(value)) continue;
      const score = pattern.length;
      if (!best || score > best.score) best = { key: area.key, label: area.label, score };
    }
  }
  return best;
}

function detectSupplierArea(supplier) {
  if (!supplier) return { ...OTHER_AREA };
  const cacheKey = supplier.id || supplier.name || '';
  if (supplierAreaCache.has(cacheKey)) return supplierAreaCache.get(cacheKey);

  const nameBlob = `${supplier.name || ''} ${supplier.folder || ''}`.toLowerCase();
  const fileBlob = (supplier.files || [])
    .map((file) => String(file.name || ''))
    .join(' ')
    .toLowerCase();

  let best = null;
  for (const area of AREA_CATALOG) {
    let score = 0;
    for (const pattern of area.patterns) {
      const regex = areaRegex(pattern);
      const nameHits = (nameBlob.match(regex) || []).length;
      const fileHits = Math.min(3, (fileBlob.match(regex) || []).length);
      if (!nameHits && !fileHits) continue;
      score += nameHits * 7 + fileHits * 2 + Math.min(2, pattern.length / 8);
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { key: area.key, label: area.label, score };
    }
  }

  const result = best || { ...OTHER_AREA };
  supplierAreaCache.set(cacheKey, result);
  return result;
}

function groupedSuppliers() {
  const groups = new Map();
  (inventory.suppliers || []).forEach((supplier, index) => {
    const area = detectSupplierArea(supplier);
    if (!groups.has(area.key)) {
      groups.set(area.key, { key: area.key, label: area.label, hotels: [] });
    }
    groups.get(area.key).hotels.push({ supplier, index, area });
  });
  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      hotels: group.hotels.sort((a, b) => a.supplier.name.localeCompare(b.supplier.name)),
    }))
    .sort((a, b) => {
      if (a.key === 'other') return 1;
      if (b.key === 'other') return -1;
      return a.label.localeCompare(b.label);
    });
}

function populateLocationFilter() {
  if (!dom.rateLocationFilter) return;
  const current = dom.rateLocationFilter.value || 'all';
  const groups = groupedSuppliers();
  const options = groups
    .map(
      (group) =>
        `<option value="${escapeHtml(group.key)}">${escapeHtml(group.label)} (${group.hotels.length})</option>`
    )
    .join('');
  dom.rateLocationFilter.innerHTML = `<option value="all">All locations</option>${options}`;
  dom.rateLocationFilter.value = groups.some((group) => group.key === current) ? current : 'all';
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

function updatePlannerCounts(quote = activeQuote()) {
  const nights = totalNights(quote);
  dom.plannerDays.textContent = String(quote.tripDays);
  dom.plannerNights.textContent = String(nights);
  dom.plannerDaysPlural.textContent = quote.tripDays === 1 ? '' : 's';
  dom.plannerNightsPlural.textContent = nights === 1 ? '' : 's';
  if (!dom.frameworkDays.value) dom.frameworkDays.value = quote.tripDays;
}

function renderPlanner() {
  const quote = activeQuote();
  ensureActiveStop(quote);
  syncTripDays(quote);

  dom.residency.value = quote.residency || 'non-resident';
  if (frameworkState.quoteId !== quote.id) {
    frameworkState.quoteId = quote.id;
    frameworkState.plan = null;
    dom.frameworkDays.value = quote.tripDays;
    renderFrameworkPlan();
  }
  dom.frameworkCurrencyLabel.textContent = quote.currency;
  dom.frameworkBuildBtn.disabled = frameworkState.busy || !serverOnline;
  updateFrameworkPills();
  updatePlannerCounts(quote);

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
    ? `${matches.length} match${matches.length === 1 ? '' : 'es'} for “${location}” · sorted by location · ${residency === 'resident' ? 'Resident' : 'Non-resident'}`
    : `No direct matches for “${location}”. Try a nearby area name or browse the full rate library.`;

  if (!matches.length) {
    dom.hotelMatchList.innerHTML = '<div class="match-empty">No matching hotels found in the synced contract library. Try another location spelling, or open the full Rate library.</div>';
    return;
  }

  dom.hotelMatchList.innerHTML = matches
    .map(({ supplier, area }, matchIndex) => {
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
        <article class="hotel-card" style="--i:${matchIndex}">
          <div class="hotel-card-head">
            <div>
              <h4>${escapeHtml(supplier.name)}</h4>
              <div class="hotel-meta">${supplier.files.length} file${supplier.files.length === 1 ? '' : 's'} · ${escapeHtml(area.label)}</div>
            </div>
            <span class="area-badge">${escapeHtml(area.label)}</span>
          </div>
          <div class="hotel-files">${fileChips || '<span class="hotel-meta">No extractable rate files</span>'}</div>
          <div class="hotel-actions">
            <button class="btn btn-primary" type="button" data-browse-supplier="${escapeHtml(supplier.id)}">Browse rates</button>
          </div>
        </article>`;
    })
    .join('');
}

/* --------------------------------------------------------------------------
   Budget planner — read contract rates, build an itinerary that fits
--------------------------------------------------------------------------- */

const RATE_NOISE_RE = /(transfer|flight|balloon|park fee|park fees|conservation|conservancy|guide|laundry|\bspa\b|activity|activities|excursion|game drive|game drives|meal|lunch|dinner|airport|airstrip|child|children|infant|kids|extra bed|supplement|deposit|conference|wedding|day room|day use|per vehicle|per group|capacity fee|vehicle capacity|per day|per trip|per stay|terms|policy|policie|cancellation|cancelled|check[\s-]?in|check[\s-]?out|release period|minimum|commission|booking|payment|will apply|applies|honeymoon|festive|easter|christmas|x[\s-]?mas|new year|photo|boat|buffet|swimming|wine|basket|additional|extra|reduction|discount|3rd adult|third adult|no show|refund|liable|penalt|\badd\.)/i;

// Rows that look like an actual accommodation rate rather than an add-on.
const RATE_ROW_RE = /(room|suite|tent|villa|cottage|cabin|chalet|banda|apartment|bungalow|double|single|twin|triple|sharing|full[\s-]?board|half[\s-]?board|bed\s*(?:&|and)\s*breakfast|breakfast|all[\s-]?inclusive|accommodation|per person per night|per person\/night|pppn|standard|deluxe|superior|luxury|family|executive|presidential|penthouse|nightly|per night)/i;

// Units that can price a stay in the framework. A column sold per child, per extra
// person or per vehicle never becomes the nightly rate.
const PRICED_UNITS = ['per_person_night', 'per_room_night', 'per_night', 'per_person', 'per_single_night'];

function sampleEvery(list, count) {
  if (list.length <= count) return list.slice();
  const step = (list.length - 1) / Math.max(1, count - 1);
  const picked = [];
  for (let index = 0; index < count; index += 1) {
    const item = list[Math.round(index * step)];
    if (item && !picked.includes(item)) picked.push(item);
  }
  return picked;
}

function rateFileCandidates(supplier, residency) {
  const files = (supplier.files || []).filter(isExtractable);
  const score = (file) => {
    const name = String(file.name || '').toLowerCase();
    let value = 0;
    if (fileMatchesResidency(file, residency)) value += 5;
    if (/rate|contract|tariff|rack|sto|nett|net|price|accommodation/.test(name)) value += 4;
    if (/resident/.test(name) && residency === 'resident') value += 3;
    if (/non[\s-]?resident/.test(name) && residency === 'non-resident') value += 3;
    if (/fact|brochure|activit|transfer|terms|policy|presentation|agenda|map|photo|offer|deal/.test(name)) value -= 7;
    if (fileExt(file) === 'xlsx') value += 1;
    return value;
  };
  return files
    .slice()
    .sort((a, b) => score(b) - score(a) || String(a.name).localeCompare(String(b.name)));
}

// Table rows carry their table's title in the description ("1. SALT LICK SAFARI
// LODGE — PARK VIEW ROOMS — High Season…"), so the property a row belongs to is
// the text before the first dash.
function tableProperty(candidate) {
  if (!Array.isArray(candidate.amountUnits) || !candidate.amountUnits.length) return '';
  return String(candidate.description || '').split(' — ')[0].replace(/^\d+\.\s*/, '').trim();
}

const PROPERTY_STOPWORDS = new Set([
  'the', 'and', 'of', 'ltd', 'limited', 'safari', 'lodge', 'camp', 'resort', 'spa', 'hotel',
  'room', 'rooms', 'suite', 'suites', 'tent', 'tents', 'cottage', 'cottages', 'view', 'views',
]);

function propertyWords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word && !PROPERTY_STOPWORDS.has(word));
}

// One contract can price several properties from the same folder (Salt Lick and
// Taita Hills share a rack-rate PDF), so drop the tables belonging to the others.
// A file that prices one property is left alone, whatever its title reads like.
function propertiesToExclude(rows, supplierName) {
  const properties = Array.from(new Set(rows.map(tableProperty).filter(Boolean)));
  if (properties.length < 2) return new Set();
  const wanted = propertyWords(supplierName);
  if (!wanted.length) return new Set();
  const matching = properties.filter((property) => {
    const words = new Set(propertyWords(property));
    const shared = wanted.filter((word) => words.has(word)).length;
    return shared >= Math.min(2, wanted.length);
  });
  if (!matching.length) return new Set();
  return new Set(properties.filter((property) => !matching.includes(property)));
}

function rateOptionsFor(item, quote, wantedResidency) {
  const adults = Math.max(1, num(quote.adults, 2));
  const party = adults + Math.max(0, num(quote.children, 0));
  const rooms = Math.max(1, Math.ceil(party / 2));
  const options = [];

  for (const file of item.files || []) {
    const excluded = propertiesToExclude(file.candidates || [], item.name);
    for (const candidate of file.candidates || []) {
      if (excluded.has(tableProperty(candidate))) continue;
      const description = String(candidate.description || '');
      if (!description) continue;
      // A table row the extractor read column by column is a rate, even when the
      // property name carries a noise word ("… Safari Resort & Spa").
      const tableRow = Array.isArray(candidate.amountUnits) && candidate.amountUnits.length > 0;
      if (!tableRow && RATE_NOISE_RE.test(description)) continue;
      const residency = String(candidate.residency || 'unknown');
      if (residency !== 'unknown' && residency !== wantedResidency) continue;
      const unit = String(candidate.unit || '');
      const labels = Array.isArray(candidate.amountLabels) ? candidate.amountLabels : [];
      const seasonsPerColumn = Array.isArray(candidate.amountSeasons) ? candidate.amountSeasons : [];
      const columnLabels = Array.isArray(candidate.amountColumns) ? candidate.amountColumns : [];
      const columnUnits = Array.isArray(candidate.amountUnits) ? candidate.amountUnits : [];
      (candidate.amounts || []).forEach((amount, index) => {
        const value = num(amount, 0);
        if (value <= 0) return;
        const rawLabel = String(labels[index] || '');
        if (tableRow && RATE_NOISE_RE.test(`${candidate.seasonHint || ''} ${rawLabel}`)) return;
        // Season-per-row tables sell each column in its own unit: "DOUBLE" per room,
        // "3rd adult" per extra person, "SINGLE" only when one guest travels alone.
        const columnUnit = columnUnits[index] || unit;
        if (!PRICED_UNITS.includes(columnUnit)) return;
        if (columnUnit === 'per_single_night' && adults > 1) return;
        const perRoom =
          columnUnit === 'per_room_night' || columnUnit === 'per_night' || columnUnit === 'per_single_night';
        const partyNightly = convertCurrency(
          value * (perRoom ? rooms : adults),
          candidate.currency || quote.currency,
          quote.currency
        );
        if (partyNightly < 20 || partyNightly > 250000) return;
        // Guard against half-parsed cells and add-on amounts.
        if (convertCurrency(partyNightly / adults, quote.currency, 'USD') < 30) return;
        // The extractor records which season each printed column prices. Never guess a
        // season here: a column it could not place stays unseasoned, and the plan says so.
        const seasons = (Array.isArray(seasonsPerColumn[index]) ? seasonsPerColumn[index] : []).filter(
          (key) => FRAMEWORK_SEASONS[key]
        );
        const columnLabel =
          columnLabels[index] ||
          (rawLabel && !/^option\s*\d+$/i.test(rawLabel) ? rawLabel : `Column ${index + 1}`);
        options.push({
          label:
            rawLabel && !/^option\s*\d+$/i.test(rawLabel)
              ? rawLabel
              : candidate.description || candidate.seasonHint || 'Rate',
          amount: value,
          unit: columnUnit,
          description,
          fileName: file.name || '',
          partyNightly,
          season: seasons[0] || '',
          seasons,
          seasonLabel: seasons.map((key) => FRAMEWORK_SEASONS[key].label).join(' / '),
          columnLabel,
          accommodation: RATE_ROW_RE.test(description) || RATE_ROW_RE.test(rawLabel),
        });
      });
    }
  }

  const seen = new Set();
  const unique = [];
  for (const option of options) {
    const key = `${option.unit}|${option.amount}|${option.label}|${option.seasons.join(',')}|${option.fileName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(option);
  }

  // Only rows that read like accommodation can price a stay. Date headers, policy
  // rows and add-ons are common on these contracts and would understate the rate.
  // Cheapest first. No percentile cut: a family suite costs about twice a double, so
  // trimming the low end would quietly drop the room an agency actually quotes.
  return unique.filter((option) => option.accommodation).sort((a, b) => a.partyNightly - b.partyNightly);
}

async function readHotelRates(entries, quote) {
  const items = entries.map((entry, index) => ({
    key: String(index),
    name: entry.supplier.name,
    location: entry.area.label,
    paths: entry.paths,
  }));
  const data = await api('/api/rates', {
    method: 'POST',
    body: JSON.stringify({ items }),
  });
  const results = Array.isArray(data.items) ? data.items : [];
  const byKey = new Map(results.map((item) => [String(item.key), item]));
  const wantedResidency = quote.residency === 'resident' ? 'resident' : 'non-resident';
  const hotels = [];

  entries.forEach((entry, index) => {
    const result = byKey.get(String(index));
    if (!result) return;
    const options = rateOptionsFor(result, quote, wantedResidency);
    if (!options.length) return;
    const best = options[0];
    hotels.push({
      supplier: entry.supplier,
      area: entry.area,
      name: entry.supplier.name,
      fileName: best.fileName,
      options,
    });
  });
  return hotels;
}

const FRAMEWORK_TIERS = {
  budget: {
    label: 'Budget',
    low: 0,
    high: 250,
    blurb: 'Simple lodges and camps, usually full board.',
  },
  midrange: {
    label: 'Mid-range',
    low: 250,
    high: 650,
    blurb: 'Comfortable lodges and permanent tented camps.',
  },
  luxury: {
    label: 'Luxury',
    low: 650,
    high: Infinity,
    blurb: 'Conservancy camps and premium lodges.',
  },
};

const FRAMEWORK_SEASONS = {
  high: { label: 'High season', hint: 'Jul–Oct and the Christmas peak' },
  shoulder: { label: 'Shoulder season', hint: 'Jan–Mar, Jun and Nov' },
  low: { label: 'Low season', hint: 'Apr–May long rains' },
};

// How long each area deserves, and where it sits on a sensible circuit.
//
// `route` groups areas by the leg they belong to, so the framework never sends a
// client back and forth across the country:
//   0      Nairobi — arrival / departure
//   10-19  southern leg: Amboseli, then Tsavo (a natural drive on to the coast)
//   20-29  Rift Valley leg: Naivasha, Nakuru, western Kenya
//   30-39  northern leg: Mount Kenya, Meru, Samburu, Laikipia
//   40-49  Masai Mara — the finale
//   50-59  coast — the beach add-on after the bush
const AREA_FRAMEWORK = {
  nairobi: { min: 1, ideal: 1, max: 2, route: 0, transfer: 'Arrival / departure hub', note: 'Arrival or departure night only.' },
  amboseli: { min: 1, ideal: 2, max: 3, route: 10, transfer: '~4 h drive from Nairobi', note: 'Elephants under Kilimanjaro; two mornings for a clear view.' },
  tsavo: { min: 1, ideal: 2, max: 3, route: 12, transfer: '5–6 h drive from Nairobi', note: 'Red elephants and space, good en route to the coast.' },
  naivasha: { min: 1, ideal: 1, max: 2, route: 20, transfer: '1.5–2 h drive from Nairobi', note: 'Boat ride and Crescent Island walk — one night is plenty.' },
  nakuru: { min: 1, ideal: 1, max: 2, route: 21, transfer: '2.5–3 h drive from Nairobi', note: 'Rhino sanctuary, usually a night en route to the Mara.' },
  western: { min: 1, ideal: 2, max: 3, route: 22, transfer: '6 h drive or ~1 h flight', note: 'Kakamega and Lake Victoria country.' },
  mtkenya: { min: 1, ideal: 1, max: 2, route: 30, transfer: '~3 h drive', note: 'Highland stop, usually one night.' },
  meru: { min: 1, ideal: 2, max: 3, route: 31, transfer: '4–5 h drive', note: 'Quiet park with Elsa’s Kopje country.' },
  samburu: { min: 1, ideal: 2, max: 3, route: 32, transfer: '5–6 h drive or ~1 h flight', note: 'Samburu Special Five — northern circuit.' },
  laikipia: { min: 1, ideal: 2, max: 3, route: 33, transfer: '3–4 h drive from Nairobi', note: 'Conservancies, rhino and night drives.' },
  mara: { min: 2, ideal: 3, max: 4, route: 40, transfer: '5–6 h drive from Nairobi or ~45 min by air', note: 'Anchor the trip here: big cats year-round, migration Jul–Oct.' },
  diani: { min: 2, ideal: 4, max: 6, route: 50, transfer: '~1 h flight or 8 h drive', note: 'Beach finale after the bush.' },
  mombasa: { min: 2, ideal: 3, max: 5, route: 51, transfer: '~1 h flight or 8 h drive', note: 'Beach finale after the bush.' },
  watamu: { min: 2, ideal: 3, max: 5, route: 52, transfer: '~1 h flight to Malindi', note: 'Beach finale after the bush.' },
  lamu: { min: 2, ideal: 3, max: 5, route: 53, transfer: 'Flight via Nairobi or Mombasa', note: 'Beach finale after the bush.' },
};

const frameworkState = { busy: false, plan: null, areas: new Set() };

function areaMeta(key) {
  const catalog = AREA_CATALOG.find((area) => area.key === key);
  const framework = AREA_FRAMEWORK[key] || { min: 1, ideal: 2, max: 3, route: 8, transfer: '', note: '' };
  return { key, label: catalog ? catalog.label : key, ...framework };
}

// Order the chosen areas into one continuous circuit. Tsavo sits between Amboseli
// and Nairobi on a southern loop, but it is also the natural stop on the road to
// the coast — so when a beach is in the trip it moves to the coast leg, after the Mara.
function orderAreas(keys) {
  const hasCoast = keys.some((key) => areaMeta(key).route >= 50);
  const rank = (key) => {
    if (key === 'tsavo' && hasCoast) return 45;
    return areaMeta(key).route;
  };
  return keys.slice().sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

function frameworkAreaKeys() {
  return AREA_CATALOG.filter((area) => AREA_FRAMEWORK[area.key]).map((area) => area.key);
}

function suggestAreas(days) {
  if (days <= 3) return ['mara'];
  if (days <= 5) return ['mara', 'naivasha'];
  if (days <= 7) return ['mara', 'amboseli'];
  if (days <= 10) return ['mara', 'amboseli', 'samburu'];
  return ['mara', 'amboseli', 'samburu', 'diani'];
}

function allocateNights(days, keys) {
  const warnings = [];
  const valid = frameworkAreaKeys();
  let areas = orderAreas(Array.from(new Set(keys.filter((key) => valid.includes(key)))));

  if (!areas.length) return { stays: [], warnings: ['Choose at least one area.'] };

  if (areas.length > 4) {
    warnings.push('Four areas is the practical maximum for one safari; the framework keeps the four best placed on the route.');
    areas = areas.slice(0, 4);
  }

  while (areas.length > 1 && areas.reduce((sum, key) => sum + areaMeta(key).min, 0) > days) {
    const droppable = areas.filter((key) => key !== 'mara');
    const drop = (droppable.length ? droppable : areas).slice(-1)[0];
    const meta = areaMeta(drop);
    warnings.push(
      `${meta.label} needs at least ${meta.min} night${meta.min === 1 ? '' : 's'}, so it is not in this ${days}-night framework.`
    );
    areas = areas.filter((key) => key !== drop);
  }

  if (areas.length > days) {
    warnings.push(`Only ${days} night${days === 1 ? '' : 's'} to place — keeping ${days} area${days === 1 ? '' : 's'}.`);
    areas = areas.slice(0, days);
  }

  const nights = new Map(areas.map((key) => [key, Math.max(1, Math.min(areaMeta(key).min, days))]));
  let remaining = days - Array.from(nights.values()).reduce((a, b) => a + b, 0);

  const priority = areas.slice().sort((a, b) => {
    const rank = (key) => (key === 'mara' ? 0 : 1);
    return rank(a) - rank(b) || areaMeta(b).ideal - areaMeta(a).ideal;
  });

  const fill = (limit) => {
    for (const key of priority) {
      if (remaining <= 0) break;
      const meta = areaMeta(key);
      if (nights.get(key) < meta[limit]) {
        nights.set(key, nights.get(key) + 1);
        remaining -= 1;
      }
    }
  };
  fill('ideal');
  fill('max');

  if (remaining > 0) {
    const last = areas[areas.length - 1];
    nights.set(last, nights.get(last) + remaining);
    warnings.push(
      `Added ${remaining} extra night${remaining === 1 ? '' : 's'} to ${areaMeta(last).label}; consider a second area instead.`
    );
  }

  let day = 1;
  const stays = areas.map((key) => {
    const meta = areaMeta(key);
    const count = nights.get(key);
    const stay = {
      key,
      label: meta.label,
      nights: count,
      from: day,
      to: day + count - 1,
      transfer: meta.transfer,
      note: meta.note,
      min: meta.min,
    };
    day += count;
    return stay;
  });

  const transitAreas = ['naivasha', 'nakuru', 'nairobi', 'mtkenya'];
  for (const stay of stays) {
    if (stay.nights < stay.min && !transitAreas.includes(stay.key)) {
      warnings.push(
        `${stay.label} gets ${stay.nights} night${stay.nights === 1 ? '' : 's'}; the usual minimum is ${stay.min}.`
      );
    }
    if (stay.nights >= 3 && ['naivasha', 'nakuru', 'nairobi'].includes(stay.key)) {
      warnings.push(`${stay.nights} nights in ${stay.label} is more than most safaris need — it is a 1-night stop.`);
    }
  }

  return { stays, warnings };
}

/* ---------------------------- room categories ---------------------------- */

function rateMealPlan(option) {
  const text = `${option.description || ''} ${option.label || ''}`;
  if (/all[\s-]?inclusive/i.test(text)) return 'All inclusive';
  if (/full[\s-]?board/i.test(text)) return 'Full board';
  if (/half[\s-]?board/i.test(text)) return 'Half board';
  if (/bed\s*(?:&|and)\s*breakfast|breakfast/i.test(text)) return 'Bed & breakfast';
  return '';
}

// Words that describe how a rate is sold rather than a room type.
const RATE_BASIS_WORDS =
  /^(?:standard|room|rooms|twin|double|single|triple|quad|adult|adults|accommodation|basis|rate|only|net|per|person|night|and|or|with|of|the|a|resident|nonresident|sharing|share)$/;

function rateRoomCategory(option) {
  let text = String(option.description || '')
    .split('|')[0]
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\bnon\s*[-–]?\s*package\b|\bpackage\b/gi, ' ')
    .replace(/\b(high|low|mid|peak|shoulder|green|festive)\s*season\b/gi, ' ')
    .replace(/\bseasons?\b/gi, ' ')
    // Printed date bands ("3/1/2027 31/3/2027", "11 Jul 2027") name the season, not the room.
    .replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b|\b20[2-3]\d\b/g, ' ')
    .replace(/\b\d{1,2}\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*/gi, ' ')
    .replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s*\d{1,2}\b/gi, ' ')
    .replace(/:/g, ' ')
    .replace(/\(cid:\s*\)/gi, ' ')
    .replace(/\b(?:us\$|usd|kes|ksh|eur|gbp)\b/gi, ' ')
    .replace(/\bper\s+person\s*(?:\/|per)?\s*night\b/gi, ' ')
    .replace(/\bper\s+person\b|\bpppn\b|\bpp\b/gi, ' ')
    .replace(/\bper\s+(?:room|suite|tent|villa|cabin)\s*(?:\/|per)?\s*night\b/gi, ' ')
    .replace(/\bper\s+night\b/gi, ' ')
    .replace(/[–—-]\s*(?:full|half)\s*board\b/gi, ' ')
    .replace(/\bbed\s*(?:&|and)\s*breakfast\b/gi, ' ')
    .replace(/\b(?:full|half)\s*board\b|\bbook\s*&\s*breakfast\b/gi, ' ')
    .replace(/\ball[\s-]?inclusive\b|\bbreakfast\b/gi, ' ')
    .replace(/^[\s—–\-|/]+/, '')
    .replace(/[\s—–\-|/]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  text = text.replace(/[\s&,;:-]+$/g, '').trim();
  if (/years sharing|own room|with parents|sharing room|\bcid\b/i.test(text)) text = '';
  if (
    !text ||
    /^(?:\d{1,2}\s*[–—-]\s*\d{1,2}|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*)$/i.test(text)
  ) {
    return 'Standard room';
  }
  text = text.replace(/^(?:rate|option\s*\d+)$/i, 'Standard room');

  // "Sharing", "Twin sharing", "Single" are how the rate is sold, not what the room is.
  // Quote them as a standard room with its occupancy; keep real room names intact.
  const sharing = /\b(?:sharing|share|pps|p\.?\s?p\.?\s?s)\b/i.test(text);
  const single = /\b(?:single|sole\s+occupancy|srs)\b/i.test(text);
  let name = text
    .replace(/\b(?:twin|double|triple|quad)\s*(?:room\s*)?sharing\b/gi, ' ')
    .replace(/\b(?:adults?\s*)?sharing\s*(?:basis|rate)?\b/gi, ' ')
    .replace(/\bpps\b|\bp\.?\s?p\.?\s?s\b/gi, ' ')
    .replace(/\b(?:sharing|single|sole\s+occupancy|srs)\b/gi, ' ')
    .replace(/\bnon[-\s]?resident\b|\bresident\b/gi, ' ')
    .replace(/[\s—–\-|/,&+]+/g, ' ')
    .replace(/\bgame\s*$/i, ' ')
    .trim();
  // A bare number is an unparsed column, not a room.
  if (/^[\d\s.,/–—-]+$/.test(name)) name = '';
  const generic =
    !name ||
    name
      .split(/[\s/&,]+/)
      .filter(Boolean)
      .every((word) => RATE_BASIS_WORDS.test(word.replace(/[^a-z]/gi, '').toLowerCase()));
  if (generic) {
    if (sharing) return 'Standard room sharing';
    if (single) return 'Standard room single';
    if (/^(?:twin|double)\s+room$/i.test(name)) return name.charAt(0).toUpperCase() + name.slice(1);
    return 'Standard room';
  }
  // Drop table numbering ("3.") and cut on a word so a long property name stays readable.
  const cleaned = name.replace(/^\d+\.\s*/, '');
  const short = cleaned.length > 42 ? cleaned.slice(0, 42).replace(/\s+\S*$/, '') : cleaned;
  return short.charAt(0).toUpperCase() + short.slice(1);
}

function tierForNightly(perPersonNight, currency) {
  const usd = convertCurrency(perPersonNight, currency || 'USD', 'USD');
  if (usd < FRAMEWORK_TIERS.midrange.low) return 'budget';
  if (usd <= FRAMEWORK_TIERS.midrange.high) return 'midrange';
  return 'luxury';
}

// Whole-unit categories are sold per unit, not per person, so they are kept out of
// the per-person framework maths (agencies can still open them in the rate library).
const UNIT_ONLY_RE = /penthouse|\bbedroom\b|\d\s*br\b|\bhouse\b|\bentire\b|whole villa/i;

function profileHotel(hotel, quote) {
  // Agencies quote adults sharing; child rates stay on the contract page.
  const pax = Math.max(1, Math.round(num(quote.adults, 2)));
  const seen = new Map();
  for (const option of hotel.options) {
    const name = rateRoomCategory(option);
    const meal = rateMealPlan(option);
    if (UNIT_ONLY_RE.test(name)) continue;
    const seasons = option.seasons || (option.season ? [option.season] : []);
    const perPersonNight = option.partyNightly / pax;
    // One category per room + meal + season + price, so two columns at the same
    // price collapse but a genuinely different season rate stays selectable.
    const key = `${name.toLowerCase()}|${meal.toLowerCase()}|${seasons.join(',')}|${Math.round(perPersonNight)}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      key,
      name,
      meal,
      season: seasons[0] || '',
      seasons,
      seasonLabel: option.seasonLabel || '',
      columnLabel: option.columnLabel || '',
      perPersonNight,
      fileName: option.fileName,
    });
  }
  const categories = Array.from(seen.values()).sort((a, b) => a.perPersonNight - b.perPersonNight);
  const lowest = categories[0] || null;
  const perPersonNight = lowest ? lowest.perPersonNight : 0;
  return {
    ...hotel,
    categories,
    perPersonNight,
    tier: tierForNightly(perPersonNight, quote.currency),
  };
}

function pickHotelForTier(hotels, tierKey) {
  if (!hotels.length) return null;
  const band = FRAMEWORK_TIERS[tierKey];
  const exact = hotels.filter((hotel) => hotel.tier === tierKey);
  if (exact.length) {
    const sorted = exact.slice().sort((a, b) => a.perPersonNight - b.perPersonNight);
    return sorted[Math.floor((sorted.length - 1) / 2)];
  }
  const distance = (hotel) => {
    if (hotel.perPersonNight < band.low) return band.low - hotel.perPersonNight;
    if (hotel.perPersonNight > band.high) return hotel.perPersonNight - band.high;
    return 0;
  };
  return hotels.slice().sort((a, b) => distance(a) - distance(b) || a.perPersonNight - b.perPersonNight)[0];
}

// Narrow each hotel to the requested season's categories. Hotels with no rate for
// that season are dropped, so the caller can price from what the contract actually has.
function seasonalPool(hotels, season, currency) {
  if (!season) return { pool: hotels, missing: [] };
  const pool = [];
  const missing = [];
  for (const hotel of hotels) {
    const categories = hotel.categories.filter((category) =>
      (category.seasons || (category.season ? [category.season] : [])).includes(season)
    );
    if (!categories.length) {
      missing.push(hotel.name);
      continue;
    }
    pool.push({
      ...hotel,
      categories,
      perPersonNight: categories[0].perPersonNight,
      tier: tierForNightly(categories[0].perPersonNight, currency),
    });
  }
  return { pool, missing };
}

function assembleFramework({ stays, hotelsByArea, tier, budget, quote, warnings, season }) {
  // Quote adults sharing; child rates are taken from the contract by hand.
  const pax = Math.max(1, Math.round(num(quote.adults, 2)));
  const children = Math.max(0, Math.round(num(quote.children, 0)));
  if (children) {
    warnings.push(
      `${children} child${children === 1 ? '' : 'ren'} travelling: child rates are not included in these totals — take them from the same contract page.`
    );
  }
  const nightsTotal = stays.reduce((sum, stay) => sum + stay.nights, 0);
  const collect = (tierKey) =>
    stays.map((stay) => {
      const all = hotelsByArea.get(stay.key) || [];
      const seasonal = seasonalPool(all, season, quote.currency);
      const pool = seasonal.pool.length ? seasonal.pool : all;
      const hotel = pickHotelForTier(pool, tierKey);
      const category = hotel && hotel.categories.length ? hotel.categories[0] : null;
      return {
        stay,
        hotel,
        category,
        // When the contract prints no column for the chosen season we still show a
        // price, but the stay says which column it came from instead of pretending.
        seasonFallback: Boolean(season) && !seasonal.pool.length,
        alternatives: pool.filter((item) => item !== hotel).slice(0, 4),
        subtotal: category ? category.perPersonNight * pax * stay.nights : 0,
      };
    });

  let chosenTier = tier;
  let picks = collect(chosenTier);
  let total = picks.reduce((sum, pick) => sum + pick.subtotal, 0);

  if (budget) {
    const down = { luxury: 'midrange', midrange: 'budget', budget: null };
    while (total > budget && down[chosenTier]) {
      const nextTier = down[chosenTier];
      warnings.push(
        `${FRAMEWORK_TIERS[chosenTier].label} hotels come to ${fmtMoney(total, quote.currency)} — stepping down to ${
          FRAMEWORK_TIERS[nextTier].label
        } to hold the cap.`
      );
      chosenTier = nextTier;
      picks = collect(chosenTier);
      total = picks.reduce((sum, pick) => sum + pick.subtotal, 0);
    }
    if (total > budget) {
      return {
        ok: false,
        reason: 'too-low',
        warnings,
        picks,
        stays,
        tier: chosenTier,
        nightsTotal,
        pax,
        message: `Even the budget hotels come to ${fmtMoney(total, quote.currency)} for ${nightsTotal} nights (${fmtMoney(
          total / pax,
          quote.currency
        )} per person). Raise the cap, shorten the trip, or drop an area.`,
      };
    }
  }

  const missing = picks.filter((pick) => !pick.hotel).map((pick) => pick.stay.label);
  if (missing.length) {
    warnings.push(`No readable contract rate for ${missing.join(', ')} — add those nights from the rate library.`);
  }

  if (season) {
    const label = FRAMEWORK_SEASONS[season].label.toLowerCase();
    for (const pick of picks) {
      if (!pick.hotel || !pick.seasonFallback) continue;
      const column = pick.category ? pick.category.columnLabel : 'another column';
      warnings.push(
        `${pick.hotel.name} prints no ${label} column — priced from ${column} instead. Check the dates on the contract.`
      );
    }
  }

  const achieved = picks.filter((pick) => pick.hotel).map((pick) => pick.hotel.tier);
  const effectiveTier =
    achieved.length && achieved.every((value) => value === achieved[0]) ? achieved[0] : 'mixed';
  if (effectiveTier === 'mixed') {
    warnings.push(
      `The ${FRAMEWORK_TIERS[chosenTier].label} contracts on file do not line up across every area — this framework mixes tiers; adjust room categories per stay.`
    );
  } else if (effectiveTier !== chosenTier) {
    warnings.push(
      `No ${FRAMEWORK_TIERS[chosenTier].label} contract was readable in every area, so the closest available ${FRAMEWORK_TIERS[effectiveTier].label} hotels are shown.`
    );
  }

  return {
    ok: true,
    stays,
    picks,
    tier: chosenTier,
    effectiveTier,
    season: season || '',
    route: stays.map((stay) => stay.label),
    budget: budget || 0,
    nightsTotal,
    pax,
    total,
    perPerson: total / pax,
    perNight: nightsTotal ? total / nightsTotal : 0,
    warnings,
  };
}

/* ------------------------------- UI state -------------------------------- */

function populateAreaChips() {
  if (!dom.frameworkAreaChips) return;
  const counts = new Map();
  for (const supplier of inventory.suppliers || []) {
    if (!(supplier.files || []).some(isExtractable)) continue;
    const area = detectSupplierArea(supplier);
    counts.set(area.key, (counts.get(area.key) || 0) + 1);
  }
  dom.frameworkAreaChips.innerHTML = AREA_CATALOG.filter((area) => AREA_FRAMEWORK[area.key])
    .map((area) => {
      const meta = areaMeta(area.key);
      const selected = frameworkState.areas.has(area.key);
      const count = counts.get(area.key) || 0;
      return `<button class="area-chip ${selected ? 'is-selected' : ''}" type="button" data-area="${escapeHtml(
        area.key
      )}" aria-pressed="${selected}">
        <span>${escapeHtml(area.label)}</span>
        <em>${meta.min}–${meta.max} nights${count ? ` · ${count} hotel${count === 1 ? '' : 's'}` : ''}</em>
      </button>`;
    })
    .join('');
  updateFrameworkPills();
}

function updateFrameworkPills() {
  if (dom.frameworkNightPill) {
    dom.frameworkNightPill.textContent = String(
      clamp(Math.round(num(dom.frameworkDays && dom.frameworkDays.value, 1)), 1, 30)
    );
  }
  if (dom.frameworkAreaPill) dom.frameworkAreaPill.textContent = String(frameworkState.areas.size);
  if (dom.frameworkAreaHint) {
    const areas = Array.from(frameworkState.areas).map((key) => areaMeta(key));
    const minimum = areas.reduce((sum, meta) => sum + meta.min, 0);
    const days = clamp(Math.round(num(dom.frameworkDays && dom.frameworkDays.value, 1)), 1, 30);
    dom.frameworkAreaHint.textContent = !areas.length
      ? 'Pick the areas the clients want, or let the framework suggest them for the nights you entered.'
      : minimum > days
        ? `${areas.length} areas need at least ${minimum} nights together; ${days} will trim the circuit.`
        : `${areas.length} area${areas.length === 1 ? '' : 's'} · ${minimum} nights minimum · nights are allocated by what each area deserves.`;
  }
}

function initFrameworkAreas(quote) {
  if (frameworkState.areas.size) return;
  const fromStops = (quote.stops || [])
    .map((stop) => detectAreaFromText(stop.location))
    .filter(Boolean)
    .map((area) => area.key);
  const days = clamp(Math.round(num(quote.tripDays, 1)) || 1, 1, 30);
  const keys = fromStops.length ? fromStops : suggestAreas(days);
  for (const key of keys) frameworkState.areas.add(key);
}

function toggleFrameworkArea(key) {
  if (!AREA_FRAMEWORK[key]) return;
  if (frameworkState.areas.has(key)) frameworkState.areas.delete(key);
  else frameworkState.areas.add(key);
  populateAreaChips();
}

function setFrameworkBusy(busy) {
  frameworkState.busy = busy;
  dom.frameworkBuildBtn.disabled = busy || !serverOnline;
  dom.frameworkBuildBtn.textContent = busy ? 'Reading contracts…' : 'Build framework';
  dom.frameworkStatus.classList.toggle('hidden', !busy);
  if (dom.frameworkPlanner) dom.frameworkPlanner.classList.toggle('is-busy', busy);
}

function setFrameworkStatus(text) {
  dom.frameworkStatusText.textContent = text;
  dom.frameworkStatus.classList.remove('hidden');
}

/* ------------------------------- build ----------------------------------- */

async function buildFramework() {
  const quote = activeQuote();
  if (frameworkState.busy) return;
  if (!serverOnline) {
    toast('Start the local server to read contract rates: python3 server.py', 'error');
    return;
  }

  const days = clamp(Math.round(num(dom.frameworkDays.value, quote.tripDays || 1)), 1, 30);
  dom.frameworkDays.value = days;
  const tier = FRAMEWORK_TIERS[dom.frameworkTier.value] ? dom.frameworkTier.value : 'midrange';
  const budget = Math.max(0, num(dom.frameworkBudget.value, 0));
  const season = FRAMEWORK_SEASONS[dom.frameworkSeason.value] ? dom.frameworkSeason.value : '';
  const keys = Array.from(frameworkState.areas);

  if (!keys.length) {
    toast('Choose the areas the clients want to visit.', 'error');
    return;
  }

  const allocation = allocateNights(days, keys);
  if (!allocation.stays.length) {
    toast('Choose at least one area.', 'error');
    return;
  }

  // Sample across each area's contract list so budget and luxury names both get a chance,
  // then read further down the list for areas where the wanted tier is missing.
  const areaStates = allocation.stays.map((stay) => ({
    stay,
    pool: (inventory.suppliers || [])
      .filter((supplier) => detectSupplierArea(supplier).key === stay.key)
      .filter((supplier) => (supplier.files || []).some(isExtractable)),
    used: new Set(),
    hotels: [],
  }));

  const entriesFor = (state, count) => {
    const remaining = state.pool.filter((supplier) => !state.used.has(supplier.id || supplier.name));
    const entries = [];
    for (const supplier of sampleEvery(remaining, count)) {
      state.used.add(supplier.id || supplier.name);
      const files = rateFileCandidates(supplier, quote.residency);
      if (!files.length) continue;
      entries.push({ supplier, area: { key: state.stay.key, label: state.stay.label }, paths: [files[0].path] });
    }
    return entries;
  };

  const readInto = async (entries) => {
    if (!entries.length) return;
    const hotels = await readHotelRates(entries, quote);
    for (const hotel of hotels) {
      const profile = profileHotel(hotel, quote);
      if (!profile.categories.length) continue;
      const state = areaStates.find((item) => item.stay.key === hotel.area.key);
      if (state) state.hotels.push(profile);
    }
  };

  const firstPass = areaStates.flatMap((state) => entriesFor(state, 5));
  if (!firstPass.length) {
    toast('No extractable rate contracts were found for those areas.', 'error');
    return;
  }

  setFrameworkBusy(true);
  setFrameworkStatus(
    `Reading net rates for ${firstPass.length} hotel${firstPass.length === 1 ? '' : 's'} across ${
      allocation.stays.length
    } area${allocation.stays.length === 1 ? '' : 's'}…`
  );

  try {
    await readInto(firstPass);

    const secondPass = areaStates
      .filter((state) => {
        const seasonal = seasonalPool(state.hotels, season, quote.currency);
        const pool = seasonal.pool.length ? seasonal.pool : state.hotels;
        return !pool.some((hotel) => hotel.tier === tier);
      })
      .flatMap((state) => entriesFor(state, 5));
    if (secondPass.length) {
      setFrameworkStatus(
        `No ${FRAMEWORK_TIERS[tier].label} hotel yet — reading ${secondPass.length} more contract${
          secondPass.length === 1 ? '' : 's'
        }…`
      );
      await readInto(secondPass);
    }

    const hotelsByArea = new Map(areaStates.map((state) => [state.stay.key, state.hotels]));

    const plan = assembleFramework({
      stays: allocation.stays,
      hotelsByArea,
      tier,
      budget,
      quote,
      season,
      warnings: allocation.warnings.slice(),
    });

    frameworkState.plan = plan;
    renderFrameworkPlan();
    if (!plan.ok) toast(plan.message, 'error');
  } catch (error) {
    toast(`Could not build the framework: ${error.message}`, 'error');
  } finally {
    setFrameworkBusy(false);
  }
}

/* ------------------------------- render ---------------------------------- */

function frameworkCategoryChips(pick, quote) {
  const pax = Math.max(1, num(quote.adults, 2) + num(quote.children, 0));
  return pick.hotel.categories
    .slice(0, 6)
    .map((category) => {
      const party = category.perPersonNight * pax;
      const isCurrent = pick.category && category.key === pick.category.key;
      return `<li class="${isCurrent ? 'is-current' : ''}">
        <span>${escapeHtml(category.name)}${category.meal ? ` · ${escapeHtml(category.meal)}` : ''}${
          category.seasonLabel ? ` · ${escapeHtml(category.seasonLabel)}` : ''
        }</span>
        <strong>${fmtMoney(category.perPersonNight, quote.currency)}<em>pp</em></strong>
        <em>${fmtMoney(party, quote.currency)}/night</em>
      </li>`;
    })
    .join('');
}

function renderFrameworkPlan() {
  const plan = frameworkState.plan;
  const quote = activeQuote();
  if (!plan) {
    dom.frameworkResult.classList.add('hidden');
    dom.frameworkResult.innerHTML = '';
    return;
  }
  dom.frameworkResult.classList.remove('hidden');

  if (!plan.ok) {
    const rates = plan.picks
      .filter((pick) => pick.hotel)
      .map(
        (pick) =>
          `<li><strong>${escapeHtml(pick.hotel.name)}</strong> — ${fmtMoney(
            pick.hotel.perPersonNight,
            quote.currency
          )} per person / night · ${escapeHtml(pick.stay.label)}</li>`
      )
      .join('');
    const notes = (plan.warnings || []).map((note) => `<li>${escapeHtml(note)}</li>`).join('');
    dom.frameworkResult.innerHTML = `
      <div class="plan-note is-warning">
        <strong>No framework fits that cap.</strong>
        <p>${escapeHtml(plan.message || 'Adjust the nights, areas or tier.')}</p>
        ${rates ? `<ul class="plan-rate-list">${rates}</ul>` : ''}
        ${notes ? `<ul class="plan-notes">${notes}</ul>` : ''}
      </div>`;
    return;
  }

  const tierInfo = FRAMEWORK_TIERS[plan.effectiveTier === 'mixed' ? plan.tier : plan.effectiveTier || plan.tier];
  const requestedLabel = FRAMEWORK_TIERS[plan.tier] ? FRAMEWORK_TIERS[plan.tier].label : '';
  const cover = plan.budget ? Math.min(100, Math.round((plan.total / plan.budget) * 100)) : 0;

  const stays = plan.picks
    .map((pick, index) => {
      const dayLabel = pick.stay.from === pick.stay.to ? `Day ${pick.stay.from}` : `Days ${pick.stay.from}–${pick.stay.to}`;
      const categoryLabel = pick.category
        ? `${escapeHtml(pick.category.name)}${pick.category.meal ? ` · ${escapeHtml(pick.category.meal)}` : ''}${
            pick.category.seasonLabel ? ` · ${escapeHtml(pick.category.seasonLabel)}` : ''
          }`
        : 'Rate on request';
      const seasonNote = pick.category
        ? `<span class="stay-season${pick.seasonFallback ? ' is-fallback' : ''}">Priced from ${escapeHtml(
            pick.category.columnLabel || pick.category.seasonLabel || 'column 1'
          )}${
            pick.seasonFallback && plan.season
              ? ` — no ${escapeHtml(FRAMEWORK_SEASONS[plan.season].label.toLowerCase())} column on this contract`
              : ''
          }</span>`
        : '';
      const options = pick.hotel
        ? pick.hotel.categories
            .map(
              (category) =>
                `<option value="${escapeHtml(category.key || '')}" ${
                  pick.category && category.key === pick.category.key ? 'selected' : ''
                }>${escapeHtml(category.name)}${category.meal ? ` · ${escapeHtml(category.meal)}` : ''}${
                  category.seasonLabel ? ` · ${escapeHtml(category.seasonLabel)}` : ''
                } — ${fmtMoney(category.perPersonNight, quote.currency)} pp</option>`
            )
            .join('')
        : '';
      return `
        <article class="framework-stay">
          <div class="stay-days">
            <strong>${escapeHtml(dayLabel)}</strong>
            <span>${pick.stay.nights} night${pick.stay.nights === 1 ? '' : 's'}</span>
          </div>
          <div class="stay-body">
            <div class="stay-head">
              <div>
                <h4>${escapeHtml(pick.stay.label)}</h4>
                <p class="plan-muted">${escapeHtml(pick.stay.transfer)}</p>
              </div>
              <span class="area-badge">${escapeHtml(pick.hotel ? pick.hotel.tier : 'no rate')}</span>
            </div>
            <p class="stay-note">${escapeHtml(pick.stay.note)}</p>
            ${
              pick.hotel
                ? `<div class="stay-hotel">
                    <div class="stay-hotel-main">
                      <strong>${escapeHtml(pick.hotel.name)}</strong>
                      <span class="plan-muted">${escapeHtml(categoryLabel)} · ${fmtMoney(
                        pick.category.perPersonNight,
                        quote.currency
                      )} per person / night</span>
                      ${seasonNote}
                    </div>
                    <div class="stay-hotel-side">
                      <strong>${fmtMoney(pick.subtotal, quote.currency)}</strong>
                      <button class="mini-btn" type="button" data-plan-library="${index}" title="Open the contract">Rates</button>
                    </div>
                    ${
                      pick.hotel.categories.length > 1
                        ? `<label class="category-picker">
                            <span>Room category</span>
                            <select data-category-select="${index}">${options}</select>
                          </label>`
                        : ''
                    }
                    <ul class="plan-rate-chips">${frameworkCategoryChips(pick, quote)}</ul>
                    ${
                      pick.alternatives && pick.alternatives.length
                        ? `<div class="stay-alternatives">
                            <span>Also read in ${escapeHtml(pick.stay.label)}</span>
                            <ul>${pick.alternatives
                              .map(
                                (alt) =>
                                  `<li><span>${escapeHtml(alt.name)}</span><strong>${fmtMoney(
                                    alt.perPersonNight,
                                    quote.currency
                                  )} pp</strong><em>${escapeHtml(alt.tier)}</em></li>`
                              )
                              .join('')}</ul>
                          </div>`
                        : ''
                    }
                  </div>`
                : `<p class="plan-flag">No readable contract rate for ${escapeHtml(pick.stay.label)} — open the rate library.</p>`
            }
          </div>
        </article>`;
    })
    .join('');

  const notes = (plan.warnings || []).map((note) => `<li>${escapeHtml(note)}</li>`).join('');

  dom.frameworkResult.innerHTML = `
    <div class="plan-summary">
      <div class="plan-total">
        <span class="plan-muted">Net accommodation · ${escapeHtml(tierInfo.label)}${
          plan.effectiveTier && plan.effectiveTier !== 'mixed' && plan.effectiveTier !== plan.tier
            ? ` (requested ${escapeHtml(requestedLabel)})`
            : ''
        } · ${plan.nightsTotal} nights</span>
        <strong>${fmtAmount(plan.total)}</strong>
        ${
          plan.budget
            ? `<div class="plan-budget-bar"><i style="width:${cover}%"></i></div>
               <span class="plan-muted">${cover}% of ${fmtMoney(plan.budget, quote.currency)} · ${fmtMoney(
                 Math.max(0, plan.budget - plan.total),
                 quote.currency
               )} left</span>`
            : ''
        }
        <span class="plan-muted">${fmtMoney(plan.perPerson, quote.currency)} per person · ${fmtMoney(
          plan.perNight,
          quote.currency
        )} per night for the party · ${plan.pax} adult${plan.pax === 1 ? '' : 's'} sharing</span>
      </div>
      <div class="plan-badges">
        <span class="planner-pill"><strong>${plan.nightsTotal}</strong> nights</span>
        <span class="planner-pill"><strong>${plan.stays.length}</strong> areas</span>
        <span class="planner-pill">${escapeHtml(tierInfo.label)}</span>
        ${
          plan.season
            ? `<span class="planner-pill" title="${escapeHtml(
                FRAMEWORK_SEASONS[plan.season].hint
              )}">${escapeHtml(FRAMEWORK_SEASONS[plan.season].label)}</span>`
            : ''
        }
      </div>
    </div>
    <p class="framework-route">Circuit: ${plan.route.map((label) => escapeHtml(label)).join(' → ')}</p>
    <p class="plan-muted framework-band">${escapeHtml(tierInfo.blurb)} Tier band: ${
      tierInfo.high === Infinity
        ? `from ${fmtMoney(tierInfo.low, 'USD')} per person / night`
        : `${fmtMoney(tierInfo.low, 'USD')}–${fmtMoney(tierInfo.high, 'USD')} per person / night`
    }.</p>
    <div class="framework-stays">${stays}</div>
    ${notes ? `<ul class="plan-notes">${notes}</ul>` : ''}
    <div class="framework-actions">
      <button class="btn btn-primary" type="button" data-framework-apply="1">Use this framework</button>
      <span class="plan-muted">Net contract rates from the PDFs. Transfers, park fees and flights are not included; your quote markup is applied on top.</span>
    </div>`;
}

function selectFrameworkCategory(index, value) {
  const plan = frameworkState.plan;
  if (!plan || !plan.ok) return;
  const pick = plan.picks[index];
  if (!pick || !pick.hotel) return;
  const category = pick.hotel.categories.find((item) => item.key === String(value));
  if (!category) return;
  pick.category = category;
  pick.subtotal = category.perPersonNight * plan.pax * pick.stay.nights;
  plan.total = plan.picks.reduce((sum, item) => sum + item.subtotal, 0);
  plan.perPerson = plan.total / plan.pax;
  plan.perNight = plan.nightsTotal ? plan.total / plan.nightsTotal : 0;
  const achieved = plan.picks.filter((item) => item.hotel).map((item) => item.hotel.tier);
  plan.effectiveTier =
    achieved.length && achieved.every((value) => value === achieved[0]) ? achieved[0] : 'mixed';
  renderFrameworkPlan();
}

function applyFrameworkPlan() {
  const plan = frameworkState.plan;
  if (!plan || !plan.ok) return;
  const quote = activeQuote();
  if (quote.lines.length && !confirm('Replace the current itinerary lines with this framework?')) return;

  const adults = Math.max(1, Math.round(num(quote.adults, 2)));
  const children = Math.max(0, Math.round(num(quote.children, 0)));
  quote.stops = plan.stays.map((stay) => createStop(stay.label, stay.nights));
  quote.tripDays = Math.max(1, plan.nightsTotal);
  if (quote.startDate) {
    const start = new Date(`${quote.startDate}T00:00:00`);
    if (!Number.isNaN(start.getTime())) {
      start.setDate(start.getDate() + quote.tripDays);
      quote.endDate = start.toISOString().slice(0, 10);
    }
  }
  quote.lines = plan.picks
    .filter((pick) => pick.hotel && pick.category)
    .map((pick) => ({
      id: uid('line'),
      supplier: pick.hotel.name,
      // The category already says "sharing" where the contract sells it that way.
      description: `${pick.stay.label} — ${pick.hotel.name} · ${pick.category.name}${
        pick.category.meal ? `, ${pick.category.meal.toLowerCase()}` : ''
      } · ${pick.stay.nights} night${pick.stay.nights === 1 ? '' : 's'}${
        /shar/i.test(pick.category.name) ? '' : ', per person sharing'
      }`,
      basis: 'per_person_night',
      rate: Math.round(pick.category.perPersonNight * 100) / 100,
      currency: quote.currency,
      units: adults,
      nights: pick.stay.nights,
      markup: null,
      season: [pick.category.seasonLabel, pick.category.meal].filter(Boolean).join(' · '),
      notes: `Net ${fmtMoney(pick.category.perPersonNight, quote.currency)} pp/night · ${adults} adult${
        adults === 1 ? '' : 's'
      } sharing${children ? ` · ${children} child${children === 1 ? '' : 'ren'} quoted separately` : ''}`,
      source: pick.category.fileName || pick.hotel.fileName || '',
    }));

  activeStopId = quote.stops.length ? quote.stops[0].id : null;
  touchQuote(quote);
  saveState(true);
  renderAll();
  toast(`Framework applied: ${plan.nightsTotal} nights, ${fmtMoney(plan.total, quote.currency)} net.`);
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

// Stops in visiting order, each with the day range its nights cover.
function stopTimeline(quote) {
  let day = 1;
  return (quote.stops || []).map((stop) => {
    const nights = Math.max(1, Math.round(num(stop.nights, 1)));
    const item = {
      location: String(stop.location || '').trim(),
      nights,
      from: day,
      to: day + nights - 1,
    };
    day += nights;
    return item;
  });
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

  const timeline = stopTimeline(quote).filter((stop) => stop.location);
  const itinerary = timeline.length
    ? `<section class="print-itinerary">
        <h3>Places visited</h3>
        <ol>${timeline
          .map(
            (stop) => `<li>
              <span class="print-day">${
                stop.from === stop.to ? `Day ${stop.from}` : `Days ${stop.from}–${stop.to}`
              }</span>
              <strong>${escapeHtml(stop.location)}</strong>
              <span class="print-nights">${stop.nights} night${stop.nights === 1 ? '' : 's'}</span>
            </li>`
          )
          .join('')}</ol>
      </section>`
    : '';

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

      ${itinerary}

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
  const locationKey = dom.rateLocationFilter ? dom.rateLocationFilter.value : 'all';
  const previousScroll = resetScroll ? 0 : dom.supplierList.scrollTop;

  if (!inventory || !Array.isArray(inventory.suppliers) || !inventory.suppliers.length) {
    dom.supplierList.innerHTML =
      '<div class="supplier-empty">No contracts loaded. Start the local server and sync the OneDrive folder.</div>';
    return;
  }

  let html = '';
  let visibleHotels = 0;

  for (const group of groupedSuppliers()) {
    if (locationKey !== 'all' && group.key !== locationKey) continue;

    let groupHtml = '';
    for (const { supplier, index: supplierIndex } of group.hotels) {
      const files = Array.isArray(supplier.files) ? supplier.files : [];
      const filteredFiles = files
        .map((file, fileIndex) => ({ file, fileIndex }))
        .filter(({ file }) => matchesRateFilter(file, filter));
      if (!filteredFiles.length) continue;

      const supplierMatches = supplier.name.toLowerCase().includes(query);
      const visibleFiles = query
        ? supplierMatches
          ? filteredFiles
          : filteredFiles.filter(({ file }) => file.name.toLowerCase().includes(query))
        : filteredFiles;
      if (!visibleFiles.length) continue;

      const isActiveSupplier = activeFile && activeFile.supplier === supplier.name;
      const open = Boolean(query) || isActiveSupplier;
      visibleHotels += 1;
      groupHtml += `<details class="supplier" data-supplier-index="${supplierIndex}" ${open ? 'open' : ''}>
        <summary title="${escapeHtml(supplier.name)}">
          <span class="supplier-name">${escapeHtml(supplier.name)}</span>
          <span class="supplier-count">${files.length}</span>
        </summary>
        <div class="file-list">`;

      for (const { file, fileIndex } of visibleFiles) {
        const active = activeFile && activeFile.file.path === file.path;
        groupHtml += `<button class="file-item ${active ? 'is-active' : ''}" type="button"
            data-supplier-index="${supplierIndex}" data-file-index="${fileIndex}"
            title="${escapeHtml(file.name)}">
          <span class="ext-badge ${extClass(file)}">${escapeHtml(fileExt(file) || 'file')}</span>
          <span class="file-copy">
            <span class="file-name">${escapeHtml(file.name)}</span>
            <span class="file-size">${formatSize(file.size)}</span>
          </span>
        </button>`;
      }

      groupHtml += '</div></details>';
    }

    if (!groupHtml) continue;
    html += `<section class="location-group" data-location="${escapeHtml(group.key)}">
      <header class="location-head">
        <span class="location-name">${escapeHtml(group.label)}</span>
        <span class="location-count">${group.hotels.length} hotel${group.hotels.length === 1 ? '' : 's'}</span>
      </header>
      ${groupHtml}
    </section>`;
  }

  dom.supplierList.innerHTML =
    html ||
    `<div class="supplier-empty">${visibleHotels ? 'No matching files.' : 'No hotels for this location yet. Sync the library or pick another location.'}</div>`;
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
  if (dom.rateLocationFilter) dom.rateLocationFilter.value = 'all';
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
  const definition = basisDefinition(basis);
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
    nights: definition.multiplier === 'days' ? quoteDays(quote) : activeStopNights(quote),
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
    if (field === 'location') {
      stop.location = event.target.value;
      // A place typed here should show up among the areas the clients want.
      const area = detectAreaFromText(stop.location);
      if (area && AREA_FRAMEWORK[area.key] && !frameworkState.areas.has(area.key)) {
        frameworkState.areas.add(area.key);
        populateAreaChips();
      }
    }
    if (field === 'nights') stop.nights = Math.max(1, Math.round(num(event.target.value, 1)));
    syncTripDays(quote);
    touchQuote(quote);
    updatePlannerCounts(quote);
    renderHotelMatches();
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
  if (dom.rateLocationFilter) {
    dom.rateLocationFilter.addEventListener('change', () => renderSuppliers({ resetScroll: true }));
  }

  dom.frameworkBuildBtn.addEventListener('click', buildFramework);
  for (const id of ['frameworkDays', 'frameworkBudget']) {
    dom[id].addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      buildFramework();
    });
  }
  dom.frameworkDays.addEventListener('input', () => {
    updateFrameworkPills();
    if (dom.frameworkDays.value.trim() === '') return;
    const quote = activeQuote();
    quote.tripDays = clamp(Math.round(num(dom.frameworkDays.value, quote.tripDays)), 1, 30);
    touchQuote(quote);
    updatePlannerCounts(quote);
    saveState();
  });

  dom.frameworkSeason.addEventListener('change', () => {
    if (frameworkState.plan && frameworkState.plan.ok) buildFramework();
  });
  dom.frameworkSuggestBtn.addEventListener('click', () => {
    const days = clamp(Math.round(num(dom.frameworkDays.value, 1)), 1, 30);
    const allocation = allocateNights(days, suggestAreas(days));
    frameworkState.areas = new Set(allocation.stays.map((stay) => stay.key));
    populateAreaChips();

    // The suggestion is an itinerary, not just a set of areas: write the circuit and
    // its nights into Places visited so the client itinerary reads in visiting order.
    const quote = activeQuote();
    const typed = (quote.stops || []).some((stop) => String(stop.location || '').trim());
    if (typed && !confirm('Replace the places visited with the suggested circuit?')) return;
    quote.stops = allocation.stays.map((stay) => createStop(stay.label, stay.nights));
    quote.tripDays = allocation.stays.reduce((sum, stay) => sum + stay.nights, 0);
    activeStopId = quote.stops.length ? quote.stops[0].id : null;
    touchQuote(quote);
    renderPlanner();
    saveState();
    toast(`Suggested circuit: ${allocation.stays.map((stay) => `${stay.label} (${stay.nights})`).join(' → ')}`);
  });
  dom.frameworkAreaChips.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-area]');
    if (!chip) return;
    toggleFrameworkArea(chip.dataset.area);
  });
  dom.frameworkResult.addEventListener('click', (event) => {
    if (event.target.closest('[data-framework-apply]')) {
      applyFrameworkPlan();
      return;
    }
    const button = event.target.closest('[data-plan-library]');
    if (!button) return;
    const plan = frameworkState.plan;
    const pick = plan && plan.ok ? plan.picks[Number(button.dataset.planLibrary)] : null;
    if (!pick || !pick.hotel) return;
    const supplier = pick.hotel.supplier;
    const fileName = (pick.category && pick.category.fileName) || pick.hotel.fileName;
    const fileIndex = (supplier.files || []).findIndex((file) => file.name === fileName);
    openSupplierFile(supplier.id, fileIndex >= 0 ? fileIndex : 0);
  });
  dom.frameworkResult.addEventListener('change', (event) => {
    const select = event.target.closest('[data-category-select]');
    if (!select) return;
    selectFrameworkCategory(Number(select.dataset.categorySelect), select.value);
  });

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




