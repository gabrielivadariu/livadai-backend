const MAX_TICKET_TYPES = 3;

const slugifyKey = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "ticket";

const toMajorPrice = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.round(numeric * 100) / 100;
};

const normalizeExperienceTicketTypes = (value, { defaultCurrency = "RON" } = {}) => {
  if (!Array.isArray(value) || !value.length) return [];

  const seen = new Set();
  const normalized = [];

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index] || {};
    const label = String(item.label || "").trim();
    if (!label) {
      return {
        error: "Each ticket category must have a label / Fiecare categorie de bilet trebuie să aibă o denumire",
        status: 400,
      };
    }

    const price = toMajorPrice(item.price);
    if (price === null) {
      return {
        error: "Each ticket category must have a valid non-negative price / Fiecare categorie de bilet trebuie să aibă un preț valid",
        status: 400,
      };
    }

    let key = String(item.key || "").trim() || slugifyKey(label);
    if (seen.has(key)) {
      key = `${key}_${index + 1}`;
    }
    seen.add(key);

    const isFree = item.isFree === true || price <= 0;
    normalized.push({
      key,
      label,
      price,
      currency: String(item.currency || defaultCurrency || "RON").toUpperCase(),
      isFree,
      countsTowardCapacity: item.countsTowardCapacity !== false,
      active: item.active !== false,
      order: Number.isFinite(Number(item.order)) ? Number(item.order) : index,
    });
  }

  if (normalized.length > MAX_TICKET_TYPES) {
    return {
      error: `You can configure up to ${MAX_TICKET_TYPES} ticket categories / Poți configura maximum ${MAX_TICKET_TYPES} categorii de bilete`,
      status: 400,
    };
  }

  return { ticketTypes: normalized.sort((a, b) => a.order - b.order) };
};

const getEffectiveTicketTypes = (experience) => {
  const explicit = Array.isArray(experience?.ticketTypes)
    ? experience.ticketTypes.filter((item) => item && item.active !== false)
    : [];

  if (explicit.length) {
    return explicit.map((item, index) => ({
      key: item.key,
      label: item.label,
      price: toMajorPrice(item.price) ?? 0,
      currency: String(item.currency || experience?.currencyCode || "RON").toUpperCase(),
      isFree: item.isFree === true || Number(item.price || 0) <= 0,
      countsTowardCapacity: item.countsTowardCapacity !== false,
      active: item.active !== false,
      order: Number.isFinite(Number(item.order)) ? Number(item.order) : index,
      isLegacy: false,
    }));
  }

  return [
    {
      key: "standard",
      label: "Standard",
      price: toMajorPrice(experience?.price) ?? 0,
      currency: String(experience?.currencyCode || "RON").toUpperCase(),
      isFree: !experience?.price || Number(experience.price) <= 0,
      countsTowardCapacity: true,
      active: true,
      order: 0,
      isLegacy: true,
    },
  ];
};

const normalizeTicketSelection = (selection, ticketTypes) => {
  if (!Array.isArray(selection) || !selection.length) return { ticketSelection: [] };

  const byKey = new Map(ticketTypes.map((item) => [String(item.key), item]));
  const merged = new Map();

  for (const raw of selection) {
    const key = String(raw?.key || "").trim();
    const quantity = Math.max(0, Math.floor(Number(raw?.quantity) || 0));
    if (!key || quantity <= 0) continue;
    const ticketType = byKey.get(key);
    if (!ticketType) {
      return {
        error: `Unknown ticket category: ${key} / Categorie necunoscută: ${key}`,
        status: 400,
      };
    }

    const current = merged.get(key) || 0;
    merged.set(key, current + quantity);
  }

  const normalized = [];
  for (const ticketType of ticketTypes) {
    const quantity = merged.get(String(ticketType.key)) || 0;
    if (!quantity) continue;
    const unitPrice = toMajorPrice(ticketType.price) ?? 0;
    normalized.push({
      key: ticketType.key,
      label: ticketType.label,
      quantity,
      unitPrice,
      lineTotal: Math.round(unitPrice * quantity * 100) / 100,
      currency: String(ticketType.currency || "RON").toUpperCase(),
      isFree: ticketType.isFree === true || unitPrice <= 0,
      countsTowardCapacity: ticketType.countsTowardCapacity !== false,
    });
  }

  return { ticketSelection: normalized };
};

const summarizeTicketSelection = (ticketSelection) => {
  const participantCount = ticketSelection.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const capacityUsed = ticketSelection.reduce(
    (sum, item) => sum + (item.countsTowardCapacity !== false ? Number(item.quantity || 0) : 0),
    0
  );
  const totalMajor = ticketSelection.reduce((sum, item) => sum + Number(item.lineTotal || 0), 0);

  return {
    participantCount,
    capacityUsed,
    totalMajor: Math.round(totalMajor * 100) / 100,
    totalMinor: Math.round(totalMajor * 100),
  };
};

module.exports = {
  MAX_TICKET_TYPES,
  normalizeExperienceTicketTypes,
  getEffectiveTicketTypes,
  normalizeTicketSelection,
  summarizeTicketSelection,
};
