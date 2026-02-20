import type { Env } from '../src/types';

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {
		R2: R2Bucket;
		VIDEOS: R2Bucket;
	}
}
