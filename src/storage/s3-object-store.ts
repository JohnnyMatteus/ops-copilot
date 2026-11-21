// Adaptador S3. O mesmo código fala com a AWS ou com o MinIO local trocando endpoint e credenciais.
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { ObjectAlreadyExistsError, type ObjectStore } from './object-store.js';

export interface S3ObjectStoreOptions {
  readonly bucket: string;
  readonly region: string;
  /** Vazio na AWS; `http://localhost:9000` no MinIO local. */
  readonly endpoint?: string | undefined;
  readonly client?: S3Client;
}

export class S3ObjectStore implements ObjectStore {
  readonly #client: S3Client;
  readonly #bucket: string;

  constructor(options: S3ObjectStoreOptions) {
    this.#bucket = options.bucket;
    // Credenciais vêm da cadeia padrão do SDK (variáveis AWS_*, perfil ou papel IAM).
    this.#client =
      options.client ??
      new S3Client({
        region: options.region,
        ...(options.endpoint ? { endpoint: options.endpoint, forcePathStyle: true } : {}),
      });
  }

  async putIfAbsent(key: string, body: string): Promise<void> {
    try {
      await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          Body: body,
          ContentType: 'application/json',
          // Escrita condicional: duas instâncias nunca gravam o mesmo número de sequência.
          IfNoneMatch: '*',
          // Object lock exige checksum na escrita.
          ChecksumAlgorithm: 'SHA256',
        }),
      );
    } catch (error) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 412) {
        throw new ObjectAlreadyExistsError(key);
      }
      throw error;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.#client.send(
        new ListObjectsV2Command({ Bucket: this.#bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const item of page.Contents ?? []) if (item.Key) keys.push(item.Key);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return keys.sort();
  }

  async get(key: string): Promise<string> {
    const response = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }));
    if (!response.Body) throw new Error(`Objeto ${key} sem corpo.`);
    return response.Body.transformToString('utf8');
  }
}
