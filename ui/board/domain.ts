import type { BoardEvent, BoardI18n as I18n } from "./types.ts";
// Pure business/date helpers retained from the verified board implementation.
let BoardI18n: Pick<I18n, "locale"> = { locale: document.documentElement.lang };
export const configureLocale = (i18n: I18n) => {
  BoardI18n = i18n;
};
const deviceZone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const effectiveZone = (zone?: string | null) => zone || deviceZone();
const dateFormat = (value: string | number | Date, zone?: string | null) =>
  new Intl.DateTimeFormat(BoardI18n.locale, {
    timeZone: effectiveZone(zone),
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
const shortDate = (value: string | number | Date, zone?: string | null) =>
  new Intl.DateTimeFormat(BoardI18n.locale, {
    timeZone: effectiveZone(zone),
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
function wallDate(value: string | number | Date, zone?: string | null) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: effectiveZone(zone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const get = (kind: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === kind)!.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}
const localDate = (value: string | number | Date) => wallDate(value, null);
function wallToISO(value: string, zone?: string | null) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))
    throw new Error("请填写完整日期与时间");
  const target = new Date(value + "Z").getTime();
  if (!Number.isFinite(target)) throw new Error("请填写有效日期");
  const offsets = new Set<number>();
  for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
    const sample = target + hours * 3600000,
      display = wallDate(sample, zone);
    offsets.add(
      new Date(display + "Z").getTime() - Math.floor(sample / 60000) * 60000,
    );
  }
  const candidates = [...offsets]
    .map((offset) => target - offset)
    .filter((stamp) => wallDate(stamp, zone) === value);
  if (candidates.length !== 1)
    throw new Error(
      candidates.length
        ? "这个时间处于夏令时重复时段，请选一个明确的时间"
        : "这个时区没有这个本地时间，请重新选择",
    );
  return new Date(candidates[0]).toISOString();
}
const zoneLabel = (
  zone?: string | null,
  value: string | number | Date = Date.now(),
) =>
  new Intl.DateTimeFormat(BoardI18n.locale, {
    timeZone: effectiveZone(zone),
    timeZoneName: "short",
  })
    .formatToParts(new Date(value))
    .find((p) => p.type === "timeZoneName")!.value;
const clock = (value: string | number | Date, zone?: string | null) =>
  new Intl.DateTimeFormat(BoardI18n.locale, {
    timeZone: effectiveZone(zone),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
const endLabel = (
  start: string | number | Date,
  end: string | number | Date,
  zone?: string | null,
) =>
  wallDate(start, zone).slice(0, 10) === wallDate(end, zone).slice(0, 10)
    ? clock(end, zone)
    : dateFormat(end, zone);
const timeRange = (e: Pick<BoardEvent, "starts_at" | "ends_at" | "timezone">) =>
  `${dateFormat(e.starts_at, e.timezone)}${e.ends_at ? "–" + endLabel(e.starts_at, e.ends_at, e.timezone) : ""} (${zoneLabel(e.timezone)})`;
const isEarlyTime = (value: string) => /^0[0-6]:[0-5]\d$/.test(value);
function shiftCalendarDate(value: string, days: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("请填写完整日期");
  const date = new Date(value + "T12:00:00Z");
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  )
    throw new Error("请填写有效日期");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
const calendarLabel = (value: string, year = true) =>
  new Intl.DateTimeFormat(BoardI18n.locale, {
    timeZone: "UTC",
    year: year ? "numeric" : undefined,
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(value + "T12:00:00Z"));
function eventStartValue(date: string, time: string, offset = "0") {
  // Calendar-day arithmetic must not depend on the device zone or DST day length.
  if (isEarlyTime(time)) {
    if (!["0", "1"].includes(offset)) throw new Error("请选择凌晨属于哪一晚");
    return shiftCalendarDate(date, Number(offset)) + "T" + time;
  }
  return date + "T" + time;
}
function schedulePreview(start: Date, end: Date, zone?: string | null) {
  const startValue = wallDate(start, zone),
    endValue = wallDate(end, zone);
  const full = (value: string) =>
    calendarLabel(value.slice(0, 10)) + " " + value.slice(11, 16);
  const lines = [
    `开始：${full(startValue)}`,
    `结束：${full(endValue)}${startValue.slice(0, 10) !== endValue.slice(0, 10) ? "（跨日）" : ""}`,
    `共 ${(+end - +start) / 3600000} 小时 · ${effectiveZone(zone)} (${zoneLabel(zone, start)})`,
  ];
  if (isEarlyTime(startValue.slice(11, 16)))
    lines.unshift(
      `这是 ${calendarLabel(shiftCalendarDate(startValue.slice(0, 10), -1))} 晚上过后的凌晨场。`,
    );
  return lines.join("\n");
}
function startCountdownText(start: string | number | Date, now = Date.now()) {
  const difference = new Date(start).getTime() - now;
  if (!Number.isFinite(difference)) return "";
  if (difference === 0) return "开始时间已到，请核对日期与时间";
  const future = difference > 0,
    absolute = Math.abs(difference);
  let duration = "不到 1 分钟";
  if (absolute >= 60000) {
    const minutes = future
        ? Math.ceil(absolute / 60000)
        : Math.floor(absolute / 60000),
      parts = [];
    const days = Math.floor(minutes / 1440),
      hours = Math.floor((minutes % 1440) / 60),
      remaining = minutes % 60;
    if (days) parts.push(`${days} 天`);
    if (hours) parts.push(`${hours} 小时`);
    if (remaining) parts.push(`${remaining} 分钟`);
    duration = parts.join(" ");
  }
  return future
    ? `距离开始还有 ${duration}`
    : `开始时间已过 ${duration}，请核对日期与时间`;
}

function eventStatus(e: BoardEvent): [string, string] {
  if (e.lifecycle === "draft") return ["草稿", "closed"];
  if (e.archived_at) return ["已归档", "closed"];
  if (e.lifecycle === "cancelled") return ["已取消", "closed"];
  if (e.lifecycle === "ended")
    return [e.settlement ? "已公布结算" : "已结束", "closed"];
  if (e.estimated_over) return ["待确认结束", "waiting"];
  if (e.phase === "ongoing") return ["进行中", ""];
  if (!e.registration_open) return ["暂停报名", "closed"];
  if (new Date(e.deadline) <= new Date()) return ["报名截止", "closed"];
  if (e.capacity > 0 && e.confirmed_count >= e.capacity)
    return ["满员 · 可候补", "waiting"];
  if (e.queue_blocked) return ["可候补", "waiting"];
  return ["可报名", ""];
}

const centsText = (cents: number) =>
  `${cents < 0 ? "-" : ""}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
function roundingText(difference: number) {
  if (!difference) return "";
  return `四舍五入到分，合计${difference > 0 ? "多" : "少"} ¥${centsText(Math.abs(difference))}，尾差由发起人处理。`;
}

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("图片读取失败，请重试"));
    reader.readAsDataURL(blob);
  });
}
async function prepareCode(file: File) {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
    throw new Error("请选择 PNG、JPG 或 WebP 图片");
  if (file.size > 10 * 1024 * 1024)
    throw new Error("图片超过 10 MB，请裁剪后上传");
  const original = await readDataUrl(file),
    image = new Image();
  image.src = original;
  try {
    await image.decode();
  } catch {
    throw new Error("无法读取这张图片，请重新选择");
  }
  let scale = Math.min(
    1,
    1200 / Math.max(image.naturalWidth, image.naturalHeight),
  );
  const canvas = document.createElement("canvas"),
    context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  for (let attempt = 0; attempt < 4; attempt++) {
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL("image/png");
    if (data.length < 2700000) return data;
    scale *= 0.75;
  }
  throw new Error("图片过大，请裁剪图片后上传");
}

export {
  calendarLabel,
  centsText,
  dateFormat,
  deviceZone,
  effectiveZone,
  eventStartValue,
  eventStatus,
  isEarlyTime,
  localDate,
  prepareCode,
  roundingText,
  schedulePreview,
  shiftCalendarDate,
  shortDate,
  startCountdownText,
  timeRange,
  wallDate,
  wallToISO,
  zoneLabel,
};
