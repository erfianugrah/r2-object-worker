import { describe, it, expect } from 'vitest';
import { getContentType, getObjectType } from '../src/utils/content-type';

describe('getContentType', () => {
	it('returns correct MIME for common extensions', () => {
		expect(getContentType('photo.jpg')).toBe('image/jpeg');
		expect(getContentType('photo.jpeg')).toBe('image/jpeg');
		expect(getContentType('photo.png')).toBe('image/png');
		expect(getContentType('photo.webp')).toBe('image/webp');
		expect(getContentType('photo.avif')).toBe('image/avif');
		expect(getContentType('photo.svg')).toBe('image/svg+xml');
		expect(getContentType('video.mp4')).toBe('video/mp4');
		expect(getContentType('doc.pdf')).toBe('application/pdf');
		expect(getContentType('style.css')).toBe('text/css');
		expect(getContentType('data.json')).toBe('application/json');
		expect(getContentType('font.woff2')).toBe('font/woff2');
		expect(getContentType('archive.zip')).toBe('application/zip');
		expect(getContentType('archive.tar')).toBe('application/x-tar');
	});

	it('is case-insensitive for extensions', () => {
		expect(getContentType('photo.JPG')).toBe('image/jpeg');
		expect(getContentType('photo.PNG')).toBe('image/png');
	});

	it('returns octet-stream for unknown extensions', () => {
		expect(getContentType('file.xyz')).toBe('application/octet-stream');
		expect(getContentType('noext')).toBe('application/octet-stream');
	});

	it('handles paths with directories', () => {
		expect(getContentType('images/photos/sunset.jpg')).toBe('image/jpeg');
	});
});

describe('getObjectType', () => {
	it('classifies image types', () => {
		expect(getObjectType('image/jpeg')).toBe('image');
		expect(getObjectType('image/png')).toBe('image');
		expect(getObjectType('image/webp')).toBe('image');
		expect(getObjectType('image/svg+xml')).toBe('image');
	});

	it('classifies video types', () => {
		expect(getObjectType('video/mp4')).toBe('video');
		expect(getObjectType('video/webm')).toBe('video');
	});

	it('classifies audio types', () => {
		expect(getObjectType('audio/mpeg')).toBe('audio');
		expect(getObjectType('audio/ogg')).toBe('audio');
	});

	it('classifies font types', () => {
		expect(getObjectType('font/woff2')).toBe('font');
		expect(getObjectType('font/ttf')).toBe('font');
		expect(getObjectType('application/vnd.ms-fontobject')).toBe('font');
	});

	it('classifies archive types', () => {
		expect(getObjectType('application/zip')).toBe('archive');
		expect(getObjectType('application/gzip')).toBe('archive');
		expect(getObjectType('application/vnd.rar')).toBe('archive');
		expect(getObjectType('application/x-tar')).toBe('archive');
		expect(getObjectType('application/x-7z-compressed')).toBe('archive');
	});

	it('classifies document types', () => {
		expect(getObjectType('application/pdf')).toBe('document');
		expect(getObjectType('text/plain')).toBe('document');
		expect(getObjectType('text/html')).toBe('document');
		expect(getObjectType('application/xml')).toBe('document');
		expect(getObjectType('application/msword')).toBe('document');
	});

	it('classifies static/web asset types', () => {
		expect(getObjectType('text/css')).toBe('static');
		expect(getObjectType('text/javascript')).toBe('static');
		expect(getObjectType('application/json')).toBe('static');
	});

	it('classifies unknown types as binary', () => {
		expect(getObjectType('application/octet-stream')).toBe('binary');
		expect(getObjectType('application/x-custom')).toBe('binary');
	});
});
