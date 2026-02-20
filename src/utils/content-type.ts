import type { ObjectType } from '../types';

const EXTENSION_MAP: Record<string, string> = {
	// Images
	png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
	webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', ico: 'image/x-icon',
	tiff: 'image/tiff', tif: 'image/tiff', bmp: 'image/bmp',
	// Documents
	pdf: 'application/pdf', doc: 'application/msword',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	xls: 'application/vnd.ms-excel',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	ppt: 'application/vnd.ms-powerpoint',
	pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	txt: 'text/plain', rtf: 'application/rtf',
	// Web assets
	html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript',
	json: 'application/json', xml: 'application/xml',
	// Archives
	zip: 'application/zip', rar: 'application/vnd.rar', gz: 'application/gzip',
	tar: 'application/x-tar', '7z': 'application/x-7z-compressed',
	// Audio
	mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/m4a',
	flac: 'audio/flac', aac: 'audio/aac',
	// Video
	mp4: 'video/mp4', webm: 'video/webm', avi: 'video/x-msvideo',
	mov: 'video/quicktime', wmv: 'video/x-ms-wmv', mkv: 'video/x-matroska',
	// Fonts
	woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
	eot: 'application/vnd.ms-fontobject',
};

/** Set of MIME types that should classify as 'archive' */
const ARCHIVE_TYPES = new Set([
	'application/zip', 'application/vnd.rar', 'application/gzip',
	'application/x-tar', 'application/x-7z-compressed',
]);

/** Set of MIME types that should classify as 'document' */
const DOCUMENT_TYPES = new Set([
	'text/html', 'text/plain', 'application/pdf', 'application/rtf',
	'application/msword',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'application/vnd.ms-excel',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'application/vnd.ms-powerpoint',
	'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	'application/xml',
]);

/** Set of MIME types that should classify as 'static' (web assets) */
const STATIC_TYPES = new Set([
	'text/css', 'text/javascript', 'application/json',
]);

export function getContentType(key: string): string {
	const ext = key.split('.').pop()?.toLowerCase() ?? '';
	return EXTENSION_MAP[ext] ?? 'application/octet-stream';
}

export function getObjectType(contentType: string): ObjectType {
	if (contentType.startsWith('image/')) return 'image';
	if (contentType.startsWith('video/')) return 'video';
	if (contentType.startsWith('audio/')) return 'audio';
	if (contentType.startsWith('font/') || contentType === 'application/vnd.ms-fontobject') return 'font';
	if (ARCHIVE_TYPES.has(contentType)) return 'archive';
	if (DOCUMENT_TYPES.has(contentType)) return 'document';
	if (STATIC_TYPES.has(contentType)) return 'static';
	return 'binary';
}

