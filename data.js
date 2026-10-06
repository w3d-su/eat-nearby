/* 常數與工具:分類對照、cuisine 對照、Overpass 查詢、localStorage helpers */

const CATEGORY_DEFS = [
  { id: 'restaurant', label: '餐廳',       tags: { amenity: ['restaurant'] } },
  { id: 'fast_food',  label: '速食',       tags: { amenity: ['fast_food'] } },
  { id: 'cafe',       label: '咖啡廳/飲料', tags: { amenity: ['cafe'], shop: ['tea'] } },
  { id: 'food_court', label: '美食街',     tags: { amenity: ['food_court'] } },
  { id: 'bar',        label: '酒吧',       tags: { amenity: ['bar', 'pub'] } },
  { id: 'dessert',    label: '冰品/甜點',  tags: { amenity: ['ice_cream'], shop: ['bakery', 'confectionery', 'dessert'] } },
];

const CATEGORY_BY_ID = Object.fromEntries(CATEGORY_DEFS.map(c => [c.id, c]));

const CUISINE_ZH = {
  taiwanese: '台式', chinese: '中式', japanese: '日式', korean: '韓式',
  italian: '義式', american: '美式', thai: '泰式', vietnamese: '越式',
  indian: '印度', mexican: '墨西哥', ramen: '拉麵', sushi: '壽司',
  hot_pot: '火鍋', hotpot: '火鍋', barbecue: '燒烤', bbq: '燒烤',
  steak_house: '牛排', burger: '漢堡', pizza: '披薩', noodle: '麵食',
  noodles: '麵食', vegetarian: '素食', vegan: '純素', seafood: '海鮮',
  bubble_tea: '手搖飲', breakfast: '早餐', brunch: '早午餐', curry: '咖哩',
  coffee_shop: '咖啡', dessert: '甜點', cake: '蛋糕', sandwich: '三明治',
  dumplings: '餃子', bento: '便當', chicken: '雞肉料理', asian: '亞洲料理',
  french: '法式', german: '德式', spanish: '西班牙', greek: '希臘',
  turkish: '土耳其', kebab: '沙威瑪', ice_cream: '冰淇淋', tea: '茶飲',
  juice: '果汁', salad: '輕食', deli: '熟食', donuts: '甜甜圈',
  pastry: '糕點', regional: '地方料理', international: '異國料理',
};

function categoryOf(tags) {
  for (const def of CATEGORY_DEFS) {
    for (const [key, vals] of Object.entries(def.tags)) {
      if (tags[key] && vals.includes(tags[key])) return def.id;
    }
  }
  return null;
}

function cuisineLabel(raw) {
  if (!raw) return null;
  const first = raw.split(';')[0].trim();
  return CUISINE_ZH[first] || first;
}

function buildOverpassQuery(lat, lng, radius) {
  const amenities = [...new Set(CATEGORY_DEFS.flatMap(c => c.tags.amenity || []))].join('|');
  const shops = [...new Set(CATEGORY_DEFS.flatMap(c => c.tags.shop || []))].join('|');
  return `[out:json][timeout:25];
(
  nwr["amenity"~"^(${amenities})$"](around:${radius},${lat},${lng});
  nwr["shop"~"^(${shops})$"](around:${radius},${lat},${lng});
);
out center tags;`;
}

const LS = {
  FAVS: 'eat-favorites',
  BLACKLIST: 'eat-blacklist',
  RECENT: 'eat-recent-picks',
  FILTERS: 'eat-filters',
};

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v !== null ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* ignore */ }
  },
};

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371e3, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function formatDist(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}
