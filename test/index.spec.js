import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../src';

describe('Object CDN Worker', () => {
  let mockEnv;
  let ctx;
  let mockR2Object;
  
  beforeEach(() => {
    // Create mock R2 object
    mockR2Object = {
      body: new Blob(['test content']),
      httpEtag: '"test-etag"',
      writeHttpMetadata: vi.fn(headers => {
        headers.set('Last-Modified', 'Wed, 01 Jan 2023 00:00:00 GMT');
      })
    };
    
    // Mock R2 bucket
    mockEnv = {
      R2: {
        get: vi.fn(),
        head: vi.fn(),
        list: vi.fn(),
      },
      // Set R2 bucket binding configuration for tests
      R2_BUCKET_BINDING: 'R2',
      // Add worker configuration
      STORAGE: {
        maxRetries: 3,
        retryDelay: 1000,
        exponentialBackoff: true,
        defaultListLimit: 100
      },
      CACHE: {
        defaultMaxAge: 86400,
        defaultStaleWhileRevalidate: 86400,
        cacheEverything: true,
        cacheTags: {
          enabled: true,
          prefix: 'cdn-',
          defaultTags: ['cdn', 'r2-objects']
        },
        objectTypeConfig: {
          image: {
            polish: 'lossy',
            webp: true,
            maxAge: 86400,
            tags: ['images']
          },
          document: {
            maxAge: 86400,
            tags: ['documents']
          }
        },
        sensitiveTypes: ['private', 'secure']
      },
      SECURITY: {
        headers: {
          default: {
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'"
          },
          image: {
            'Content-Security-Policy': "default-src 'none'; img-src 'self'"
          }
        }
      },
      ENVIRONMENT: 'test'
      }
    };
    ctx = createExecutionContext();
  });

  it('responds with "Object CDN" for root path', async () => {
    const request = new Request('http://example.com/');
    const response = await worker.fetch(request, mockEnv, ctx);
    await waitOnExecutionContext(ctx);
    
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Object CDN");
  });

  it('responds with OK for health check endpoint', async () => {
    mockEnv.R2.list.mockResolvedValue({ objects: [] });
    
    const request = new Request('http://example.com/_health');
    const response = await worker.fetch(request, mockEnv, ctx);
    await waitOnExecutionContext(ctx);
    
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
    expect(mockEnv.R2.list).toHaveBeenCalledWith({ limit: 1 });
  });

  it('responds with Service Unavailable when health check fails', async () => {
    mockEnv.R2.list.mockRejectedValue(new Error('Connection error'));
    
    const request = new Request('http://example.com/_health');
    const response = await worker.fetch(request, mockEnv, ctx);
    await waitOnExecutionContext(ctx);
    
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Service Unavailable");
  });

  it('returns 404 for non-existent objects', async () => {
    mockEnv.R2.get.mockResolvedValue(null);
    
    const request = new Request('http://example.com/image.jpg');
    const response = await worker.fetch(request, mockEnv, ctx);
    await waitOnExecutionContext(ctx);
    
    expect(response.status).toBe(404);
    expect(mockEnv.R2.get).toHaveBeenCalled();
  });

  it('returns object with correct content type and caching headers', async () => {
    mockEnv.R2.get.mockResolvedValue(mockR2Object);
    
    const request = new Request('http://example.com/document.pdf');
    const response = await worker.fetch(request, mockEnv, ctx);
    await waitOnExecutionContext(ctx);
    
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/pdf');
    expect(response.headers.get('Cache-Control')).toContain('public');
    expect(response.headers.get('Cache-Control')).toContain('max-age=');
    expect(response.headers.get('Etag')).toBe('"test-etag"');
    expect(mockR2Object.writeHttpMetadata).toHaveBeenCalled();
  });

  it('returns object listing with JSON response', async () => {
    mockEnv.R2.list.mockResolvedValue({
      objects: [
        { key: 'file1.jpg', size: 1024, etag: 'etag1', uploaded: new Date() },
        { key: 'file2.pdf', size: 2048, etag: 'etag2', uploaded: new Date() }
      ],
      truncated: false,
      cursor: 'cursor1'
    });
    
    const request = new Request('http://example.com/_list?prefix=file');
    const response = await worker.fetch(request, mockEnv, ctx);
    await waitOnExecutionContext(ctx);
    
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    
    const data = await response.json();
    expect(data.objects).toHaveLength(2);
    expect(data.objects[0].key).toBe('file1.jpg');
    expect(data.objects[0].type).toBe('image');
    expect(data.objects[1].key).toBe('file2.pdf');
    expect(data.objects[1].type).toBe('document');
    expect(data.truncated).toBe(false);
    
    expect(mockEnv.R2.list).toHaveBeenCalledWith({
      prefix: 'file',
      limit: 100,
      cursor: undefined,
      delimiter: undefined,
      include: undefined
    });
  });
  
  it('returns 405 Method Not Allowed for unsupported methods', async () => {
    const request = new Request('http://example.com/', { method: 'POST' });
    const response = await worker.fetch(request, mockEnv, ctx);
    await waitOnExecutionContext(ctx);
    
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
    expect(await response.text()).toBe('Method Not Allowed');
  });
});
