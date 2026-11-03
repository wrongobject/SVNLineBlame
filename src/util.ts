import * as fs from 'fs';
import * as path from 'path';

/** 解码 svn --xml 输出中的 XML 实体 */
export function decodeXml(text: string): string {
    return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
        .replace(/&amp;/g, '&');
}

/** 转义 Markdown 中的特殊字符，避免用户内容破坏排版 */
export function escapeMarkdown(text: string): string {
    return text.replace(/([\\`*_{}[\]()#+\-.!|])/g, '\\$1');
}

/** 从文件所在目录向上查找 .svn，返回工作副本根目录；不存在则返回 undefined */
export function findWorkingCopyRoot(filePath: string): string | undefined {
    let dir = path.dirname(filePath);
    while (true) {
        try {
            if (fs.existsSync(path.join(dir, '.svn'))) {
                return dir;
            }
        } catch {
            return undefined;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            return undefined;
        }
        dir = parent;
    }
}

/** 解析 svn 的 ISO 时间（UTC），如 2024-05-01T12:34:56.123456Z */
export function parseSvnDate(text: string): Date | undefined {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z?$/.exec(text.trim());
    if (!m) {
        const fallback = new Date(text);
        return isNaN(fallback.getTime()) ? undefined : fallback;
    }
    const ms = m[7] ? Number(m[7].slice(0, 3).padEnd(3, '0')) : 0;
    return new Date(Date.UTC(
        Number(m[1]), Number(m[2]) - 1, Number(m[3]),
        Number(m[4]), Number(m[5]), Number(m[6]), ms
    ));
}

/** 按 YYYY / MM / DD / HH / mm / ss 占位符格式化日期（本地时区） */
export function formatDate(date: Date, format: string): string {
    const pad = (n: number, len = 2) => String(n).padStart(len, '0');
    return format
        .replace(/YYYY/g, pad(date.getFullYear(), 4))
        .replace(/MM/g, pad(date.getMonth() + 1))
        .replace(/DD/g, pad(date.getDate()))
        .replace(/HH/g, pad(date.getHours()))
        .replace(/mm/g, pad(date.getMinutes()))
        .replace(/ss/g, pad(date.getSeconds()));
}

/** 相对时间，如 "刚刚"、"3 天前" */
export function relativeTime(date: Date, now: Date = new Date()): string {
    const diff = Math.max(0, now.getTime() - date.getTime());
    const sec = Math.floor(diff / 1000);
    if (sec < 60) {
        return '刚刚';
    }
    const min = Math.floor(sec / 60);
    if (min < 60) {
        return `${min} 分钟前`;
    }
    const hour = Math.floor(min / 60);
    if (hour < 24) {
        return `${hour} 小时前`;
    }
    const day = Math.floor(hour / 24);
    if (day < 30) {
        return `${day} 天前`;
    }
    const month = Math.floor(day / 30);
    if (month < 12) {
        return `${month} 个月前`;
    }
    return `${Math.floor(day / 365)} 年前`;
}
