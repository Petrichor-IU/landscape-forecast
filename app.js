const API = {
  photon: "https://photon.komoot.io/api/",
  nominatim: "https://nominatim.openstreetmap.org/search",
  geocode: "https://geocoding-api.open-meteo.com/v1/search",
  elevation: "https://api.open-meteo.com/v1/elevation",
  forecast: "https://api.open-meteo.com/v1/forecast",
};

const LOCATION_CACHE_KEY = "landscape-location-cache-v4";
const LOCATION_CACHE_LIMIT = 30;
const FAST_SEARCH_TIMEOUT = 1900;
const DETAIL_SEARCH_TIMEOUT = 2600;

const SCENES = [
  { id: "sunrise", title: "朝霞", type: "日出前后", accent: "#d95b43" },
  { id: "sunset", title: "晚霞", type: "日落前后", accent: "#d48a1f" },
  { id: "burning", title: "火烧云", type: "强霞光", accent: "#c84835" },
  { id: "milkyway", title: "星空银河", type: "暗夜透明度", accent: "#5c5794" },
  { id: "meteors", title: "流星雨", type: "天文窗口", accent: "#267b8c" },
  { id: "seacloud", title: "云海", type: "地形和逆温", accent: "#1f5d49" },
];

const MAJOR_SHOWERS = [
  { name: "象限仪座流星雨", start: [1, 1], peak: [1, 4], end: [1, 12], zhr: 110 },
  { name: "英仙座流星雨", start: [7, 17], peak: [8, 12], end: [8, 24], zhr: 100 },
  { name: "猎户座流星雨", start: [10, 2], peak: [10, 21], end: [11, 7], zhr: 20 },
  { name: "狮子座流星雨", start: [11, 6], peak: [11, 17], end: [11, 30], zhr: 15 },
  { name: "双子座流星雨", start: [12, 4], peak: [12, 14], end: [12, 17], zhr: 120 },
  { name: "小熊座流星雨", start: [12, 17], peak: [12, 22], end: [12, 26], zhr: 10 },
];

const els = {
  form: document.querySelector("#forecast-form"),
  location: document.querySelector("#location-input"),
  locationPanel: document.querySelector("#location-panel"),
  locationCount: document.querySelector("#location-count"),
  locationOptions: document.querySelector("#location-options"),
  time: document.querySelector("#time-input"),
  altitude: document.querySelector("#altitude-input"),
  altitudeOutput: document.querySelector("#altitude-output"),
  altitudeSource: document.querySelector("#altitude-source"),
  mountain: document.querySelector("#mountain-toggle"),
  geo: document.querySelector("#geo-button"),
  status: document.querySelector("#status"),
  cards: document.querySelector("#cards"),
  sceneTabs: document.querySelector("#scene-tabs"),
  template: document.querySelector("#card-template"),
  canvas: document.querySelector("#sky-canvas"),
  stageLabel: document.querySelector("#stage-label"),
  stageLocation: document.querySelector("#stage-location"),
  metrics: {
    cloud: document.querySelector("#metric-cloud"),
    humidity: document.querySelector("#metric-humidity"),
    visibility: document.querySelector("#metric-visibility"),
    moon: document.querySelector("#metric-moon"),
  },
};

const state = {
  altitudeTouched: false,
  altitudeLocationKey: "",
  locationCandidates: [],
  selectedLocation: null,
  selectedLocationInput: "",
  requestId: 0,
  selectedSceneId: "",
  latestResults: [],
};

function pad(value) {
  return String(value).padStart(2, "0");
}

function toDatetimeLocal(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function humanDateTime(date) {
  return toDatetimeLocal(date).replace("T", " ");
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function locationKey(location) {
  return `${Number(location.latitude).toFixed(4)},${Number(location.longitude).toFixed(4)}`;
}

function normalizeAltitude(value) {
  const min = Number(els.altitude.min);
  const max = Number(els.altitude.max);
  const step = Number(els.altitude.step) || 1;
  const clamped = clamp(Math.round(value), min, max);
  return Math.round((clamped - min) / step) * step + min;
}

function coordLabel(location) {
  return `${Number(location.latitude).toFixed(4)}, ${Number(location.longitude).toFixed(4)}`;
}

function locationDisplayName(location) {
  return [location.name, location.admin1, location.country].filter(Boolean).join(" · ");
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}

function loadLocationCache() {
  try {
    const raw = localStorage.getItem(LOCATION_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveLocationCache(cache) {
  try {
    const entries = Object.entries(cache)
      .sort((a, b) => (b[1].time || 0) - (a[1].time || 0))
      .slice(0, LOCATION_CACHE_LIMIT);
    localStorage.setItem(LOCATION_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Cache is only a speed-up; ignore private-mode or quota failures.
  }
}

function getCachedLocations(input) {
  const key = input.trim().toLowerCase();
  const hit = loadLocationCache()[key];
  if (!hit || !Array.isArray(hit.items)) return null;
  return hit.items;
}

function cacheLocations(input, items) {
  if (!items.length) return;
  const cache = loadLocationCache();
  cache[input.trim().toLowerCase()] = { time: Date.now(), items };
  saveLocationCache(cache);
}

function isTerrainLikeInput(input) {
  const compact = input.replace(/\s+/g, "");
  return /山|峰|顶|岭|谷|峡|湖|海|湾|岛|滩|瀑|寺|村|镇|景区|公园|观景|露营|草原|湿地|水库/.test(compact);
}

function hasExactOsmCandidate(input, candidates) {
  const compact = input.replace(/\s+/g, "").toLowerCase();
  return candidates.some((item) => {
    const name = String(item.name || "").replace(/\s+/g, "").toLowerCase();
    return item.source === "OpenStreetMap" && (name === compact || name.includes(compact) || compact.includes(name));
  });
}

function needsDetailedLocationSearch(input, fastCandidates) {
  const compact = input.replace(/\s+/g, "");
  if (!fastCandidates.length) return true;
  if (hasExactOsmCandidate(input, fastCandidates)) return false;
  if (isTerrainLikeInput(input)) return true;
  if (compact.length <= 4) return false;
  return true;
}

function scoreRange(value, idealMin, idealMax, softMin, softMax) {
  if (value >= idealMin && value <= idealMax) return 100;
  if (value < idealMin) return clamp(((value - softMin) / (idealMin - softMin)) * 100);
  return clamp(((softMax - value) / (softMax - idealMax)) * 100);
}

function hourWindowScore(hour, start, end, falloffHours = 2) {
  const candidates = [hour, hour + 24, hour - 24];
  let best = 0;
  candidates.forEach((candidate) => {
    if (candidate >= start && candidate <= end) {
      best = 100;
      return;
    }
    const distance = Math.min(Math.abs(candidate - start), Math.abs(candidate - end));
    best = Math.max(best, clamp(100 - (distance / falloffHours) * 100));
  });
  return best;
}

function nearestIndex(times, target) {
  const targetMs = target.getTime();
  let best = 0;
  let bestDelta = Infinity;
  times.forEach((time, index) => {
    const delta = Math.abs(new Date(time).getTime() - targetMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = index;
    }
  });
  return best;
}

function getHourlyAt(hourly, index) {
  const item = {};
  Object.keys(hourly).forEach((key) => {
    if (key !== "time") item[key] = hourly[key][index];
  });
  item.time = hourly.time[index];
  return item;
}

function dateOnly(value) {
  return value.slice(0, 10);
}

function getDailyFor(forecast, targetDate) {
  const day = dateOnly(toDatetimeLocal(targetDate));
  const index = forecast.daily.time.findIndex((item) => item === day);
  return index < 0 ? null : Object.fromEntries(Object.keys(forecast.daily).map((key) => [key, forecast.daily[key][index]]));
}

function mean(values) {
  const filtered = values.filter((value) => Number.isFinite(value));
  return filtered.length ? filtered.reduce((sum, value) => sum + value, 0) / filtered.length : 0;
}

function maxBy(values, scorer) {
  return values.reduce((best, item) => (scorer(item) > scorer(best) ? item : best), values[0]);
}

function getWindow(hourly, target, beforeHours, afterHours) {
  const start = target.getTime() - beforeHours * 3600000;
  const end = target.getTime() + afterHours * 3600000;
  return hourly.time
    .map((time, index) => ({ time: new Date(time).getTime(), index }))
    .filter((item) => item.time >= start && item.time <= end)
    .map((item) => getHourlyAt(hourly, item.index));
}

function moonIllumination(date) {
  const synodicMonth = 29.530588853;
  const knownNewMoon = Date.UTC(2000, 0, 6, 18, 14);
  const days = (date.getTime() - knownNewMoon) / 86400000;
  const phase = ((days % synodicMonth) + synodicMonth) % synodicMonth;
  return (1 - Math.cos((2 * Math.PI * phase) / synodicMonth)) / 2;
}

function meteorWindow(date) {
  const year = date.getFullYear();
  const currentDay = dayOfYear(date);
  let best = { name: "无主要流星雨峰值", strength: 10, daysFromPeak: 99, zhr: 0 };

  MAJOR_SHOWERS.forEach((shower) => {
    const start = dayOfYear(new Date(year, shower.start[0] - 1, shower.start[1]));
    const peak = dayOfYear(new Date(year, shower.peak[0] - 1, shower.peak[1]));
    const end = dayOfYear(new Date(year, shower.end[0] - 1, shower.end[1]));
    const active =
      start <= end ? currentDay >= start && currentDay <= end : currentDay >= start || currentDay <= end;
    const daysFromPeak = Math.abs(currentDay - peak);
    if (active || daysFromPeak < best.daysFromPeak) {
      const width = active ? Math.max(Math.abs(end - start), 1) : 18;
      const proximity = clamp(100 - (daysFromPeak / Math.max(width / 2, 1)) * 80);
      const strength = clamp(proximity * 0.62 + Math.min(shower.zhr, 120) * 0.38);
      if (strength > best.strength) best = { name: shower.name, strength, daysFromPeak, zhr: shower.zhr };
    }
  });

  return best;
}

function dayOfYear(date) {
  const start = new Date(date.getFullYear(), 0, 0);
  return Math.floor((date - start) / 86400000);
}

function scoreTwilight(hour, daily, kind) {
  const solarTime = kind === "sunrise" ? daily?.sunrise : daily?.sunset;
  if (!solarTime) return 30;
  const deltaMinutes = Math.abs(new Date(hour.time).getTime() - new Date(solarTime).getTime()) / 60000;
  return clamp(100 - Math.max(0, deltaMinutes - 15) * 1.8);
}

function scoreSunGap(hour, kind) {
  const lowCloud = hour.cloud_cover_low ?? 0;
  const total = hour.cloud_cover ?? 0;
  const lowPenalty = scoreRange(lowCloud, 0, 42, 0, 95);
  const totalPenalty = scoreRange(total, 22, 82, 0, 100);
  const precipitationPenalty = scoreRange(hour.precipitation_probability ?? 0, 0, 25, 0, 90);
  return lowPenalty * 0.45 + totalPenalty * 0.35 + precipitationPenalty * 0.2 + (kind === "sunset" ? 2 : 0);
}

function gateByWindow(rawScore, windowScore, strict = false) {
  if (windowScore < 15) return Math.min(rawScore, strict ? 12 : 24);
  if (windowScore < 45) return Math.min(rawScore, strict ? 34 : 48);
  if (windowScore < 70) return Math.min(rawScore, 64);
  return rawScore;
}

function darknessScore(target, daily) {
  if (!daily?.sunrise || !daily?.sunset) return target.getHours() < 5 || target.getHours() > 21 ? 80 : 15;
  const sunrise = new Date(daily.sunrise).getTime();
  const sunset = new Date(daily.sunset).getTime();
  const current = target.getTime();
  const minutesBeforeSunrise = (sunrise - current) / 60000;
  const minutesAfterSunset = (current - sunset) / 60000;

  if (minutesBeforeSunrise >= 100 || minutesAfterSunset >= 100) return 100;
  if (minutesBeforeSunrise > 0) return clamp((minutesBeforeSunrise / 100) * 100);
  if (minutesAfterSunset > 0) return clamp((minutesAfterSunset / 100) * 100);
  return 0;
}

function milkyWayCoreScore(target, latitude = 30) {
  const month = target.getMonth() + 1;
  const hour = target.getHours() + target.getMinutes() / 60;
  const northernSeason = [0, 0, 12, 45, 72, 92, 100, 96, 82, 55, 24, 6, 0][month];
  const southernSeason = [0, 55, 68, 78, 86, 92, 96, 95, 88, 75, 62, 52, 48][month];
  const season = latitude < 0 ? southernSeason : northernSeason;
  let timeWindow = 20;

  if (month >= 3 && month <= 5) {
    timeWindow = hourWindowScore(hour, 1.5, 4.7, 2.2);
  } else if (month >= 6 && month <= 8) {
    timeWindow = hourWindowScore(hour, 21.2, 27.8, 2);
  } else if (month >= 9 && month <= 10) {
    timeWindow = hourWindowScore(hour, 19.2, 22.3, 2);
  }

  return clamp(season * 0.68 + timeWindow * 0.32);
}

function activeMeteorScore(meteor) {
  if (meteor.zhr <= 0 || meteor.daysFromPeak > 18) return 8;
  const peakScore = clamp(100 - meteor.daysFromPeak * 12);
  const strengthScore = clamp((meteor.zhr / 120) * 100);
  return peakScore * 0.58 + strengthScore * 0.42;
}

function estimateCloudSeaLayer(hour, altitude, terrain, mountain) {
  const humidity = hour.relative_humidity_2m ?? 0;
  const lowCloud = hour.cloud_cover_low ?? hour.cloud_cover ?? 0;
  const wind = hour.wind_speed_10m ?? 0;
  const temperature = hour.temperature_2m;
  const dewPoint = hour.dew_point_2m;
  const spread = Number.isFinite(temperature) && Number.isFinite(dewPoint) ? Math.max(0, temperature - dewPoint) : null;
  const lcl = spread === null ? clamp((100 - humidity) * 32, 0, 1800) : clamp(spread * 125, 0, 1800);
  const relief = terrain?.relief ?? (mountain ? 520 : 160);
  const terrainFloor = terrain?.min ?? altitude - relief * 0.65;
  const valleyFloor = terrain ? terrainFloor : Math.min(terrainFloor, altitude - Math.min(relief * 0.55, mountain ? 720 : 260));
  const base = valleyFloor + Math.min(lcl * 0.4, mountain ? 260 : 180);
  const inversionDepth = clamp(
    relief * 0.45 + lowCloud * 2.4 + Math.max(0, humidity - 82) * 12 - wind * 8 + lcl * 0.35,
    mountain ? 320 : 180,
    mountain ? 1300 : 780,
  );
  const top = valleyFloor + inversionDepth;
  const thickness = Math.max(80, top - base);
  const clearance = altitude - top;
  let vantageScore = 8;

  if (clearance >= 130) {
    vantageScore = 100;
  } else if (clearance >= 0) {
    vantageScore = 62 + (clearance / 130) * 38;
  } else if (clearance >= -180) {
    vantageScore = 25 + ((clearance + 180) / 180) * 37;
  }

  return {
    base,
    top,
    thickness,
    clearance,
    relief,
    vantageScore: clamp(vantageScore),
  };
}

function buildPredictions(context) {
  const { hour, daily, target, hourly, altitude, mountain, terrain, location } = context;
  const midHigh = mean([hour.cloud_cover_mid ?? 0, hour.cloud_cover_high ?? 0]);
  const prettyClouds = scoreRange(midHigh, 30, 78, 0, 100);
  const lowCloudClear = scoreRange(hour.cloud_cover_low ?? 0, 0, 40, 0, 100);
  const humidityGlow = scoreRange(hour.relative_humidity_2m ?? 0, 45, 82, 15, 100);
  const visibilityKm = (hour.visibility ?? 0) / 1000;
  const visibilityScore = scoreRange(visibilityKm, 12, 40, 2, 60);
  const precipSafe = scoreRange(hour.precipitation_probability ?? 0, 0, 25, 0, 90);
  const moon = moonIllumination(target);
  const moonDark = clamp(100 - moon * 120);
  const darkSky = darknessScore(target, daily);
  const meteor = meteorWindow(target);
  const meteorActivity = activeMeteorScore(meteor);
  const recent = getWindow(hourly, target, 18, 0);
  const nextMorning = getWindow(hourly, target, 0, 9);
  const seaCloudHour = maxBy(nextMorning.length ? nextMorning : [hour], (item) => {
    return (item.relative_humidity_2m ?? 0) * 0.52 + (item.cloud_cover_low ?? 0) * 0.28 - (item.wind_speed_10m ?? 0) * 0.2;
  });
  const recentRain = mean(recent.map((item) => item.precipitation_probability ?? 0));
  const morningHumidity = mean(nextMorning.map((item) => item.relative_humidity_2m ?? 0)) || seaCloudHour.relative_humidity_2m || 0;
  const morningWind = mean(nextMorning.map((item) => item.wind_speed_10m ?? 0)) || seaCloudHour.wind_speed_10m || 0;
  const cloudLayer = estimateCloudSeaLayer(seaCloudHour, altitude, terrain, mountain);
  const reliefScore = scoreRange(cloudLayer.relief, 220, 1600, 0, 2600);
  const sunriseWindow = scoreTwilight(hour, daily, "sunrise");
  const sunsetWindow = scoreTwilight(hour, daily, "sunset");
  const twilightWindow = Math.max(sunriseWindow, sunsetWindow);
  const seaCloudFormation =
    scoreRange(morningHumidity, 82, 100, 55, 100) * 0.28 +
    scoreRange(morningWind, 0, 10, 0, 28) * 0.22 +
    scoreRange(recentRain, 20, 72, 0, 100) * 0.18 +
    scoreRange(seaCloudHour.cloud_cover_low ?? 0, 35, 92, 0, 100) * 0.12 +
    (mountain ? 8 : 0) +
    reliefScore * 0.1;
  let seaCloudScore = seaCloudFormation * 0.62 + cloudLayer.vantageScore * 0.38;
  if (cloudLayer.clearance < -160) seaCloudScore = Math.min(seaCloudScore, 28);
  if (cloudLayer.clearance >= -160 && cloudLayer.clearance < 80) seaCloudScore = Math.min(seaCloudScore, 56);
  const milkyCore = milkyWayCoreScore(target, location?.latitude ?? 30);

  const sunriseRaw =
    sunriseWindow * 0.22 +
    prettyClouds * 0.26 +
    scoreSunGap(hour, "sunrise") * 0.24 +
    humidityGlow * 0.14 +
    visibilityScore * 0.14;

  const sunsetRaw =
    sunsetWindow * 0.22 +
    prettyClouds * 0.26 +
    scoreSunGap(hour, "sunset") * 0.24 +
    humidityGlow * 0.14 +
    visibilityScore * 0.14;
  const sunriseScore = gateByWindow(sunriseRaw, sunriseWindow, true);
  const sunsetScore = gateByWindow(sunsetRaw, sunsetWindow, true);

  const burningRaw =
    Math.max(sunriseRaw, sunsetRaw) * 0.36 +
    scoreRange(midHigh, 42, 88, 10, 100) * 0.24 +
    lowCloudClear * 0.14 +
    humidityGlow * 0.12 +
    precipSafe * 0.14;
  const burningScore = gateByWindow(burningRaw, twilightWindow, true);

  const milkyWayRaw =
    darkSky * 0.22 +
    moonDark * 0.2 +
    milkyCore * 0.22 +
    scoreRange(hour.cloud_cover ?? 0, 0, 18, 0, 72) * 0.18 +
    scoreRange(hour.relative_humidity_2m ?? 0, 0, 68, 0, 98) * 0.1 +
    visibilityScore * 0.08;
  const milkyWayScore = gateByWindow(milkyWayRaw, darkSky, true);

  const meteorRaw =
    meteorActivity * 0.32 +
    darkSky * 0.18 +
    moonDark * 0.2 +
    scoreRange(hour.cloud_cover ?? 0, 0, 25, 0, 80) * 0.18 +
    visibilityScore * 0.14;
  const meteorScore = gateByWindow(meteorRaw, darkSky, true);

  return [
    makeResult("sunrise", sunriseScore, [
      `距日出窗口匹配度 ${Math.round(sunriseWindow)}%，不在窗口内会直接压低可观测度`,
      `中高云 ${Math.round(midHigh)}%，适合被低角度阳光染色`,
      `低云 ${Math.round(hour.cloud_cover_low ?? 0)}%，决定东方低空是否透光`,
      `能见度 ${visibilityKm.toFixed(1)} km`,
    ]),
    makeResult("sunset", sunsetScore, [
      `距日落窗口匹配度 ${Math.round(sunsetWindow)}%，不在窗口内会直接压低可观测度`,
      `中高云 ${Math.round(midHigh)}%，云量过少或过厚都会降分`,
      `低云 ${Math.round(hour.cloud_cover_low ?? 0)}%，决定西方低空是否透光`,
      `降水概率 ${Math.round(hour.precipitation_probability ?? 0)}%`,
    ]),
    makeResult("burning", burningScore, [
      `日出/日落窗口匹配度 ${Math.round(twilightWindow)}%，火烧云必须接近低角度阳光窗口`,
      `强霞光依赖中高云、地平线透光和适度湿度同时出现`,
      `中高云 ${Math.round(midHigh)}%，湿度 ${Math.round(hour.relative_humidity_2m ?? 0)}%`,
      `低云 ${Math.round(hour.cloud_cover_low ?? 0)}%，过厚会挡住反射光`,
      `能见度 ${visibilityKm.toFixed(1)} km`,
    ]),
    makeResult("milkyway", milkyWayScore, [
      darkSky >= 75 ? "当前接近天文黑夜窗口" : "暮光或白天会显著压低银河可见度",
      `银河核心季节/时段匹配度 ${Math.round(milkyCore)}%`,
      `月面照亮约 ${Math.round(moon * 100)}%，越接近新月越好`,
      `总云量 ${Math.round(hour.cloud_cover ?? 0)}%，星空需要尽量少云`,
      `湿度 ${Math.round(hour.relative_humidity_2m ?? 0)}%，高湿会让天空泛白并增加结露`,
    ]),
    makeResult("meteors", meteorScore, [
      `${meteor.name}，距峰值约 ${meteor.daysFromPeak} 天`,
      `流星雨活跃度匹配 ${Math.round(meteorActivity)}%`,
      `月面照亮约 ${Math.round(moon * 100)}%`,
      `总云量 ${Math.round(hour.cloud_cover ?? 0)}%，能见度 ${visibilityKm.toFixed(1)} km`,
      darkSky >= 75 ? "当前有足够暗的观测窗口" : "白天或暮光时段会明显压低可见数量",
    ]),
    makeResult("seacloud", seaCloudScore, [
      `清晨湿度参考 ${Math.round(morningHumidity)}%，风速参考 ${morningWind.toFixed(1)} km/h`,
      `过去 18 小时降水概率均值 ${Math.round(recentRain)}%`,
      `估算低云层顶部约 ${Math.round(cloudLayer.top)} m，机位高出云顶约 ${Math.round(cloudLayer.clearance)} m`,
      cloudLayer.clearance >= 80
        ? "机位预计在云层之上，具备俯瞰云海的高度条件"
        : "机位可能低于或处在云层内，即使有低云也不一定能看成云海",
      terrain ? `周边地形起伏约 ${Math.round(cloudLayer.relief)} m` : "缺少周边地形采样，云海高度判断偏保守",
    ]),
  ];
}

function makeResult(id, rawScore, reasons) {
  const scene = SCENES.find((item) => item.id === id);
  const score = Math.round(clamp(rawScore));
  const verdict =
    score >= 78
      ? "观测条件比较完整，值得认真准备。"
      : score >= 58
        ? "有机会观测到，但需要现场复核云缝和局地变化。"
        : score >= 38
          ? "观测条件一般，可以作为备选机位或顺路尝试。"
          : "当前机位观测条件偏弱，不建议专门奔赴。";
  return { ...scene, score, verdict, reasons };
}

function renderCards(results) {
  state.latestResults = results;
  if (!results.some((result) => result.id === state.selectedSceneId)) {
    state.selectedSceneId = [...results].sort((a, b) => b.score - a.score)[0]?.id || results[0]?.id || "";
  }
  renderSceneTabs(results);
  renderSelectedCard();
}

function renderSceneTabs(results) {
  els.sceneTabs.innerHTML = "";
  results.forEach((result) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "scene-tab";
    button.dataset.sceneId = result.id;
    button.id = `tab-${result.id}`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(result.id === state.selectedSceneId));
    button.setAttribute("aria-controls", "cards");
    button.style.setProperty("--accent", result.accent);
    button.innerHTML = `
      <span class="scene-tab-title"></span>
      <span class="scene-tab-score"></span>
    `;
    button.querySelector(".scene-tab-title").textContent = result.title;
    button.querySelector(".scene-tab-score").textContent = `可观测 ${result.score}%`;
    els.sceneTabs.append(button);
  });
  scrollActiveSceneTab();
}

function renderSelectedCard() {
  const result = state.latestResults.find((item) => item.id === state.selectedSceneId) || state.latestResults[0];
  els.cards.innerHTML = "";
  if (!result) return;
  [...els.sceneTabs.querySelectorAll(".scene-tab")].forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.sceneId === result.id));
  });
  scrollActiveSceneTab();
  const node = els.template.content.firstElementChild.cloneNode(true);
  node.style.setProperty("--accent", result.accent);
  node.style.setProperty("--score", result.score);
  node.setAttribute("role", "tabpanel");
  node.setAttribute("aria-labelledby", `tab-${result.id}`);
  node.querySelector(".card-type").textContent = result.type;
  node.querySelector("h2").textContent = result.title;
  node.querySelector(".score-ring strong").textContent = `${result.score}%`;
  node.querySelector(".score-ring").setAttribute("aria-label", `观测可行性 ${result.score}%`);
  node.querySelector(".verdict").textContent = result.verdict;
  const list = node.querySelector(".reasons");
  result.reasons.forEach((reason) => {
    const li = document.createElement("li");
    li.textContent = reason;
    list.append(li);
  });
  els.cards.append(node);
}

function scrollActiveSceneTab() {
  const active = els.sceneTabs.querySelector('.scene-tab[aria-selected="true"]');
  if (!active) return;
  window.requestAnimationFrame(() => {
    const left = active.offsetLeft - (els.sceneTabs.clientWidth - active.offsetWidth) / 2;
    els.sceneTabs.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
  });
}

function renderMetrics(hour, target) {
  els.metrics.cloud.textContent = `${Math.round(hour.cloud_cover ?? 0)}%`;
  els.metrics.humidity.textContent = `${Math.round(hour.relative_humidity_2m ?? 0)}%`;
  els.metrics.visibility.textContent = `${((hour.visibility ?? 0) / 1000).toFixed(1)} km`;
  els.metrics.moon.textContent = `${Math.round(moonIllumination(target) * 100)}%`;
}

function drawSky(results = [], hour = {}, target = new Date()) {
  const ctx = els.canvas.getContext("2d");
  const { width, height } = els.canvas;
  const best = [...results].sort((a, b) => b.score - a.score)[0];
  const night = hour.is_day === 0 || target.getHours() < 5 || target.getHours() > 20;
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  if (night) {
    gradient.addColorStop(0, "#11152f");
    gradient.addColorStop(0.55, "#253e55");
    gradient.addColorStop(1, "#18221f");
  } else if (best?.id === "sunrise" || best?.id === "sunset" || best?.id === "burning") {
    gradient.addColorStop(0, "#415f84");
    gradient.addColorStop(0.46, "#dc7b53");
    gradient.addColorStop(0.72, "#f1bd72");
    gradient.addColorStop(1, "#314d3f");
  } else {
    gradient.addColorStop(0, "#78a8bd");
    gradient.addColorStop(0.68, "#d9e7df");
    gradient.addColorStop(1, "#456d52");
  }
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const cloudAmount = clamp(hour.cloud_cover ?? 38, 8, 96);
  ctx.globalAlpha = night ? 0.32 : 0.42;
  ctx.fillStyle = "#ffffff";
  for (let i = 0; i < cloudAmount / 5; i += 1) {
    const x = ((i * 193) % width) - 80;
    const y = 38 + ((i * 47) % 150);
    const w = 130 + ((i * 29) % 140);
    drawCloud(ctx, x, y, w, 34 + ((i * 13) % 34));
  }
  ctx.globalAlpha = 1;

  if (night) {
    ctx.fillStyle = "#ffffff";
    for (let i = 0; i < 90; i += 1) {
      const x = (i * 71) % width;
      const y = (i * 43) % Math.floor(height * 0.62);
      const radius = i % 9 === 0 ? 1.8 : 1;
      ctx.globalAlpha = 0.35 + ((i % 5) * 0.12);
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 0.38;
    ctx.strokeStyle = "#d7d9ff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(width * 0.12, height * 0.55);
    ctx.bezierCurveTo(width * 0.34, height * 0.2, width * 0.58, height * 0.3, width * 0.84, height * 0.05);
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
  ctx.fillStyle = "#20362e";
  ctx.beginPath();
  ctx.moveTo(0, height);
  ctx.lineTo(0, height * 0.72);
  ctx.lineTo(width * 0.15, height * 0.56);
  ctx.lineTo(width * 0.28, height * 0.68);
  ctx.lineTo(width * 0.46, height * 0.48);
  ctx.lineTo(width * 0.62, height * 0.66);
  ctx.lineTo(width * 0.8, height * 0.52);
  ctx.lineTo(width, height * 0.7);
  ctx.lineTo(width, height);
  ctx.closePath();
  ctx.fill();
}

function drawCloud(ctx, x, y, width, height) {
  ctx.beginPath();
  ctx.ellipse(x + width * 0.22, y + height * 0.56, width * 0.24, height * 0.42, 0, 0, Math.PI * 2);
  ctx.ellipse(x + width * 0.45, y + height * 0.42, width * 0.32, height * 0.56, 0, 0, Math.PI * 2);
  ctx.ellipse(x + width * 0.7, y + height * 0.58, width * 0.28, height * 0.4, 0, 0, Math.PI * 2);
  ctx.rect(x + width * 0.16, y + height * 0.55, width * 0.64, height * 0.32);
  ctx.fill();
}

async function resolveLocation(input) {
  const coordMatch = input.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (coordMatch) {
    hideLocationPanel();
    return {
      name: "自定义坐标",
      latitude: Number(coordMatch[1]),
      longitude: Number(coordMatch[2]),
      country: "",
      admin1: "",
      source: "坐标",
    };
  }

  if (state.selectedLocation && state.selectedLocationInput === input) {
    hideLocationPanel();
    return state.selectedLocation;
  }

  const candidates = await searchLocations(input);
  if (els.location.value.trim() !== input) {
    throw Object.assign(new Error("搜索已取消"), { cancelled: true });
  }
  if (!candidates.length) {
    hideLocationPanel();
    throw new Error("没有找到这个地点，请换一个更具体的名称或输入经纬度。");
  }
  if (candidates.length === 1) {
    state.selectedLocation = candidates[0];
    state.selectedLocationInput = input;
    hideLocationPanel();
    return candidates[0];
  }

  state.locationCandidates = candidates;
  renderLocationChoices(candidates);
  throw new Error(`找到 ${candidates.length} 个可能地点，请先选择具体机位。`);
}

async function searchLocations(input) {
  const cached = getCachedLocations(input);
  if (cached) return cached;

  const terrainLike = isTerrainLikeInput(input);
  if (terrainLike) setStatus("正在并行搜索精确机位...");
  const photonTask = searchPhoton(input).catch(() => []);
  const openMeteoTask = searchOpenMeteo(input).catch(() => []);
  const nominatimTask = terrainLike ? searchNominatim(input).catch(() => []) : Promise.resolve([]);
  const [photon, openMeteo, initialNominatim] = await Promise.all([photonTask, openMeteoTask, nominatimTask]);
  let candidates = rankLocationCandidates(input, dedupeLocations([...photon, ...initialNominatim, ...openMeteo])).slice(0, 10);

  if (!terrainLike && needsDetailedLocationSearch(input, candidates)) {
    setStatus("正在补充精确机位候选...");
    const nominatim = await searchNominatim(input).catch(() => []);
    candidates = rankLocationCandidates(input, dedupeLocations([...photon, ...nominatim, ...openMeteo])).slice(0, 10);
  }

  cacheLocations(input, candidates);
  return candidates;
}

function locationRank(input, location) {
  const compact = input.replace(/\s+/g, "").toLowerCase();
  const name = String(location.name || "").replace(/\s+/g, "").toLowerCase();
  const detail = `${location.detail || ""} ${location.admin1 || ""}`.toLowerCase();
  let score = 0;
  if (name === compact) score += 90;
  else if (name.includes(compact) || compact.includes(name)) score += 54;
  if (location.source === "OpenStreetMap") score += 22;
  if (/peak|mountain|hill|natural|tourism|attraction|viewpoint|park|山|峰|顶|景区|公园/.test(detail)) score += 18;
  if (Number.isFinite(location.elevation)) score += 6;
  if (/city|administrative|人口/.test(detail)) score -= isTerrainLikeInput(input) ? 18 : 0;
  return score;
}

function rankLocationCandidates(input, candidates) {
  return [...candidates].sort((a, b) => locationRank(input, b) - locationRank(input, a));
}

async function searchPhoton(input) {
  const params = new URLSearchParams({
    q: input,
    limit: "8",
  });
  const data = await fetchJson(`${API.photon}?${params}`, FAST_SEARCH_TIMEOUT);
  return (data?.features || [])
    .map((feature) => {
      const [longitude, latitude] = feature.geometry?.coordinates || [];
      const props = feature.properties || {};
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !props.name) return null;
      const admin1 = [props.state, props.county, props.city || props.district].filter(Boolean).join(" · ");
      const kind = [props.osm_key, props.osm_value].filter(Boolean).join("/");
      return {
        name: props.name,
        latitude,
        longitude,
        country: props.country || "",
        admin1,
        detail: [props.street, props.postcode, kind].filter(Boolean).join(" · "),
        source: "OpenStreetMap",
      };
    })
    .filter(Boolean);
}

async function searchNominatim(input) {
  const params = new URLSearchParams({
    q: input,
    format: "jsonv2",
    addressdetails: "1",
    namedetails: "1",
    limit: "8",
    "accept-language": "zh-CN,zh,en",
  });
  const data = await fetchJson(`${API.nominatim}?${params}`, DETAIL_SEARCH_TIMEOUT);
  return (data || [])
    .map((item) => {
      const latitude = Number(item.lat);
      const longitude = Number(item.lon);
      const address = item.address || {};
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      const name =
        item.namedetails?.name ||
        address.peak ||
        address.tourism ||
        address.attraction ||
        address.natural ||
        address.village ||
        address.town ||
        address.city ||
        (item.display_name || "").split(",")[0];
      const admin1 = [
        address.state,
        address.county || address.city,
        address.town || address.village || address.suburb,
      ]
        .filter(Boolean)
        .join(" · ");
      return {
        name: name || item.display_name || input,
        latitude,
        longitude,
        country: address.country || "",
        admin1,
        detail: [item.category, item.type].filter(Boolean).join("/") || item.addresstype || "",
        source: "OpenStreetMap",
      };
    })
    .filter(Boolean);
}

async function searchOpenMeteo(input) {
  const params = new URLSearchParams({
    name: input,
    count: "8",
    language: "zh",
    format: "json",
  });
  const data = await fetchJson(`${API.geocode}?${params}`, FAST_SEARCH_TIMEOUT);
  return (data?.results || []).map((item) => ({
    name: item.name,
    latitude: item.latitude,
    longitude: item.longitude,
    country: item.country || "",
    admin1: [item.admin1, item.admin2, item.admin3].filter(Boolean).join(" · "),
    elevation: item.elevation,
    detail: item.population ? `人口 ${item.population.toLocaleString()}` : "",
    source: "Open-Meteo",
  }));
}

function dedupeLocations(locations) {
  const seen = new Set();
  const unique = [];
  locations.forEach((location) => {
    const key = `${location.name}|${Number(location.latitude).toFixed(3)}|${Number(location.longitude).toFixed(3)}`;
    if (seen.has(key)) return;
    seen.add(key);
    unique.push(location);
  });
  return unique;
}

function renderLocationChoices(candidates) {
  clearPredictions("等待选择地点", "请选择具体机位");
  els.locationPanel.hidden = false;
  els.locationCount.textContent = `${candidates.length} 个候选`;
  els.locationOptions.innerHTML = "";
  candidates.forEach((candidate, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "location-option";
    button.dataset.index = String(index);
    button.innerHTML = `
      <span class="location-option-name"></span>
      <span class="location-option-detail"></span>
      <span class="location-option-coord"></span>
    `;
    button.querySelector(".location-option-name").textContent = candidate.name;
    button.querySelector(".location-option-detail").textContent =
      [candidate.admin1, candidate.country, candidate.detail, candidate.source].filter(Boolean).join(" · ") ||
      candidate.source;
    button.querySelector(".location-option-coord").textContent = coordLabel(candidate);
    els.locationOptions.append(button);
  });
}

function hideLocationPanel() {
  els.locationPanel.hidden = true;
  els.locationOptions.innerHTML = "";
  els.locationCount.textContent = "";
}

function clearPredictions(label = "等待预测", location = "选择地点与时间") {
  els.cards.innerHTML = "";
  els.sceneTabs.innerHTML = "";
  state.latestResults = [];
  els.metrics.cloud.textContent = "--";
  els.metrics.humidity.textContent = "--";
  els.metrics.visibility.textContent = "--";
  els.metrics.moon.textContent = "--";
  els.stageLabel.textContent = label;
  els.stageLocation.textContent = location;
  drawSky();
}

async function fetchForecast(location) {
  const params = new URLSearchParams({
    latitude: location.latitude,
    longitude: location.longitude,
    timezone: "auto",
    forecast_days: "16",
    past_days: "1",
    wind_speed_unit: "kmh",
    hourly:
      "temperature_2m,relative_humidity_2m,dew_point_2m,precipitation_probability,precipitation,weather_code,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,visibility,wind_speed_10m,wind_gusts_10m,cape,is_day,shortwave_radiation,direct_radiation,diffuse_radiation",
    daily:
      "sunrise,sunset,precipitation_sum,precipitation_probability_max,weather_code,temperature_2m_max,temperature_2m_min,wind_speed_10m_max",
  });
  const response = await fetch(`${API.forecast}?${params}`);
  if (!response.ok) throw new Error("天气数据获取失败");
  return response.json();
}

async function fetchElevation(location) {
  if (Number.isFinite(location.elevation)) {
    return { value: location.elevation, source: "地点库" };
  }

  const params = new URLSearchParams({
    latitude: location.latitude,
    longitude: location.longitude,
  });
  const response = await fetch(`${API.elevation}?${params}`);
  if (!response.ok) throw new Error("海拔数据获取失败");
  const data = await response.json();
  const value = data.elevation?.[0];
  if (!Number.isFinite(value)) throw new Error("海拔数据不可用");
  return { value, source: "地形模型" };
}

async function fetchTerrainProfile(location) {
  const lat = Number(location.latitude);
  const lon = Number(location.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const radiusKm = 6;
  const latStep = radiusKm / 111;
  const lonStep = radiusKm / (111 * Math.max(Math.cos((lat * Math.PI) / 180), 0.2));
  const points = [
    [lat, lon],
    [lat + latStep, lon],
    [lat - latStep, lon],
    [lat, lon + lonStep],
    [lat, lon - lonStep],
    [lat + latStep * 0.7, lon + lonStep * 0.7],
    [lat + latStep * 0.7, lon - lonStep * 0.7],
    [lat - latStep * 0.7, lon + lonStep * 0.7],
    [lat - latStep * 0.7, lon - lonStep * 0.7],
  ];
  const params = new URLSearchParams({
    latitude: points.map((point) => point[0].toFixed(5)).join(","),
    longitude: points.map((point) => point[1].toFixed(5)).join(","),
  });
  const response = await fetch(`${API.elevation}?${params}`);
  if (!response.ok) throw new Error("地形采样失败");
  const data = await response.json();
  const elevations = (data.elevation || []).filter(Number.isFinite);
  if (elevations.length < 3) return null;
  const min = Math.min(...elevations);
  const max = Math.max(...elevations);
  return {
    min,
    max,
    mean: mean(elevations),
    relief: max - min,
    samples: elevations.length,
  };
}

function applyAutoAltitude(location, elevationResult, forecast) {
  const key = locationKey(location);
  const autoValue = elevationResult?.value ?? forecast.elevation;
  const shouldUpdate = key !== state.altitudeLocationKey || !state.altitudeTouched;

  if (Number.isFinite(autoValue) && shouldUpdate) {
    els.altitude.value = normalizeAltitude(autoValue);
    state.altitudeTouched = false;
    state.altitudeLocationKey = key;
    updateAltitude(elevationResult?.source || "天气模型");
    return Number(els.altitude.value);
  }

  state.altitudeLocationKey = key;
  updateAltitude(state.altitudeTouched ? "手动修正" : elevationResult?.source || "天气模型");
  return Number(els.altitude.value);
}

async function runForecast(event) {
  event?.preventDefault();
  const input = els.location.value.trim();
  const requestId = ++state.requestId;
  if (!input) {
    setStatus("请输入地点。", true);
    return;
  }

  try {
    if (!state.selectedLocation || state.selectedLocationInput !== input) {
      hideLocationPanel();
      clearPredictions("正在搜索地点", "等待地点候选");
    }
    setStatus("正在搜索地点候选...");
    const target = new Date(els.time.value);
    if (Number.isNaN(target.getTime())) throw new Error("请选择有效时间。");
    const location = await resolveLocation(input);
    if (requestId !== state.requestId) return;
    setStatus("正在获取天气、地形和天文窗口...");
    const [forecast, elevationResult, terrain] = await Promise.all([
      fetchForecast(location),
      fetchElevation(location).catch(() => null),
      fetchTerrainProfile(location).catch(() => null),
    ]);
    if (requestId !== state.requestId) return;
    const firstForecast = new Date(forecast.hourly.time[0]);
    const lastForecast = new Date(forecast.hourly.time.at(-1));
    if (target < firstForecast || target > lastForecast) {
      throw new Error(`天气预报只覆盖 ${humanDateTime(firstForecast)} 到 ${humanDateTime(lastForecast)}，请选这个范围内的时间。`);
    }
    const index = nearestIndex(forecast.hourly.time, target);
    const hour = getHourlyAt(forecast.hourly, index);
    const daily = getDailyFor(forecast, target);
    const altitude = applyAutoAltitude(location, elevationResult, forecast);
    const context = {
      hour,
      daily,
      target,
      hourly: forecast.hourly,
      altitude,
      mountain: els.mountain.checked,
      terrain,
      location,
    };
    const results = buildPredictions(context);
    const label = locationDisplayName(location);
    renderCards(results);
    renderMetrics(hour, target);
    drawSky(results, hour, target);
    els.stageLabel.textContent = `${humanDateTime(target)} · 模型小时 ${hour.time.replace("T", " ")}`;
    els.stageLocation.textContent = label || coordLabel(location);
    setStatus(`已完成：${label || "自定义坐标"}（${coordLabel(location)}），拍摄点海拔按 ${Math.round(altitude)} m 估算。结果表示当前机位的观测可行性，临近日出日落前仍建议复核卫星云图。`);
  } catch (error) {
    if (error.cancelled || requestId !== state.requestId) return;
    if (!els.locationPanel.hidden || error.message?.includes("没有找到")) {
      clearPredictions(!els.locationPanel.hidden ? "等待选择地点" : "等待预测", !els.locationPanel.hidden ? "请选择具体机位" : "选择地点与时间");
    }
    setStatus(error.message || "预测失败，请稍后再试。", true);
  }
}

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle("error", isError);
}

function updateAltitude(source = "") {
  els.altitudeOutput.textContent = `${els.altitude.value} m`;
  if (source) {
    els.altitudeSource.textContent = source === "手动修正" ? "已手动修正，同一地点再次预测会保留这个海拔" : `已按${source}自动估算，可手动微调`;
  }
}

function useBrowserLocation() {
  if (!navigator.geolocation) {
    setStatus("当前浏览器不支持定位，可以手动输入地点或经纬度。", true);
    return;
  }
  setStatus("正在读取浏览器定位...");
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const { latitude, longitude } = position.coords;
      els.location.value = `${latitude.toFixed(5)},${longitude.toFixed(5)}`;
      state.selectedLocation = null;
      state.selectedLocationInput = "";
      setStatus("已填入当前位置坐标。");
      runForecast();
    },
    () => setStatus("定位未授权或失败，可以手动输入地点。", true),
    { enableHighAccuracy: true, timeout: 8000 },
  );
}

function init() {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  els.time.value = toDatetimeLocal(now);
  const min = new Date(now);
  min.setDate(min.getDate() - 1);
  const max = new Date(now);
  max.setDate(max.getDate() + 15);
  els.time.min = toDatetimeLocal(min);
  els.time.max = toDatetimeLocal(max);
  updateAltitude();
  drawSky();
  els.form.addEventListener("submit", runForecast);
  els.location.addEventListener("input", () => {
    state.selectedLocation = null;
    state.selectedLocationInput = "";
  });
  els.locationOptions.addEventListener("click", (event) => {
    const button = event.target.closest(".location-option");
    if (!button) return;
    const candidate = state.locationCandidates[Number(button.dataset.index)];
    if (!candidate) return;
    state.selectedLocation = candidate;
    els.location.value = locationDisplayName(candidate) || candidate.name;
    state.selectedLocationInput = els.location.value.trim();
    hideLocationPanel();
    runForecast();
  });
  els.sceneTabs.addEventListener("click", (event) => {
    const button = event.target.closest(".scene-tab");
    if (!button) return;
    state.selectedSceneId = button.dataset.sceneId;
    renderSelectedCard();
  });
  els.altitude.addEventListener("input", () => {
    state.altitudeTouched = true;
    updateAltitude("手动修正");
  });
  els.geo.addEventListener("click", useBrowserLocation);
}

init();
