import { type PathLike, type ReadStream, createReadStream } from "node:fs";
import { basename } from "node:path";
import type { Readable } from "node:stream";
import {
	CopyObjectCommand,
	DeleteBucketTaggingCommand,
	DeleteObjectCommand,
	DeleteObjectTaggingCommand,
	GetBucketCorsCommand,
	GetBucketEncryptionCommand,
	GetBucketLocationCommand,
	GetBucketTaggingCommand,
	GetObjectCommand,
	GetObjectTaggingCommand,
	HeadBucketCommand,
	HeadObjectCommand,
	ListObjectsCommand,
	PutBucketTaggingCommand,
	PutObjectCommand,
	PutObjectTaggingCommand,
	type S3Client as R2,
} from "@aws-sdk/client-s3";
import { type Progress, Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { CORSPolicy, HeadObjectResponse, ObjectListResponse, Tag, UploadFileResponse } from "./types";

export class Bucket {
	private r2: R2;
	private endpoint: string;
	private bucketPublicUrls: string[] = [];

	/**
	 * Name of the bucket.
	 * @readonly
	 */
	public readonly name: string;

	/**
	 * URI of the bucket.
	 * @readonly
	 */
	public readonly uri: string;

	/**
	 * Instantiate `Bucket`.
	 * @param r2 R2 instance.
	 * @param bucketName Name of the bucket.
	 * @param endpoint Cloudflare R2 base endpoint.
	 */
	constructor(r2: R2, bucketName: string, endpoint: string) {
		this.r2 = r2;
		this.name = bucketName;
		this.endpoint = new URL(endpoint).origin;
		this.uri = `${this.endpoint}/${this.name}`;
	}

	/**
	 * Returns the name of the current bucket.
	 */
	public getBucketName(): string {
		return this.name;
	}

	/**
	 * Returns the URI for the current bucket.
	 */
	public getUri(): string {
		return this.uri;
	}

	public provideBucketPublicUrl(bucketPublicUrl: string): this;
	public provideBucketPublicUrl(bucketPublicUrls: string[]): this;

	/**
	 * Sets the public URL for the current bucket. If public access to the bucket is allowed, use this method to provide bucket public URL to this `Bucket` object.
	 * @param bucketPublicUrl The public URL of the current bucket.
	 * @note If public access to the bucket is not allowed, the public URL set by this method will not be accessible to the public. Invoking this function will not have any effect on the security or access permissions of the bucket.
	 */
	public provideBucketPublicUrl(bucketPublicUrl: string | string[]): this {
		if (typeof bucketPublicUrl === "string") {
			const origin = new URL(bucketPublicUrl).origin;
			if (!this.bucketPublicUrls.includes(origin)) this.bucketPublicUrls.push(origin);
		} else if (Array.isArray(bucketPublicUrl)) {
			for (const url of bucketPublicUrl) {
				this.provideBucketPublicUrl(url);
			}
		}

		return this;
	}

	/**
	 * **DEPRECATED. This method will be removed in the next major version. Use `getPublicUrls()` instead.**
	 *
	 * Returns the bucket public URL if it's set with `provideBucketPublicUrl` method.
	 * @deprecated
	 */
	public getPublicUrl(): string | undefined {
		return this.bucketPublicUrls.length ? this.bucketPublicUrls.at(0) : undefined;
	}

	/**
	 * Returns all public URLs of the bucket if it's set with `provideBucketPublicUrl()` method.
	 */
	public getPublicUrls(): string[] {
		return this.bucketPublicUrls;
	}

	/**
	 * Returns the signed URL of an object. This method does not check whether the object exists or not.
	 * @param objectKey
	 * @param expiresIn Expiration time in seconds.
	 */
	public async getObjectSignedUrl(objectKey: string, expiresIn: number): Promise<string> {
		const obj = new GetObjectCommand({
			Bucket: this.name,
			Key: objectKey,
		});
		const signedUrl = await getSignedUrl(this.r2, obj, { expiresIn });
		return signedUrl;
	}

	/**
	 * Generates object public URL if the bucket public URL is set with `provideBucketPublicUrl` method.
	 * @param objectKey
	 */
	protected generateObjectPublicUrl(objectKey: string): string | null {
		if (!this.bucketPublicUrls.length) return null;

		return `${this.bucketPublicUrls.at(0)}/${objectKey}`;
	}

	/**
	 * Generates object public URLs if the bucket public URL is set with `provideBucketPublicUrl` method.
	 * @param objectKey
	 */
	protected generateObjectPublicUrls(objectKey: string): string[] {
		if (!this.bucketPublicUrls.length) return [];

		return this.bucketPublicUrls.map((publicUrl) => `${publicUrl}/${objectKey}`);
	}

	/**
	 * Returns all public URL of an object in the bucket.
	 * @param objectKey
	 */
	public getObjectPublicUrls(objectKey: string): string[] {
		return this.bucketPublicUrls.map((bucketPublicUrl) => `${bucketPublicUrl}/${objectKey}`);
	}

	/**
	 * Checks if the bucket exists and you have permission to access it.
	 * @param bucketName
	 */
	public async exists(): Promise<boolean> {
		try {
			const result = await this.r2.send(
				new HeadBucketCommand({
					Bucket: this.name,
				}),
			);

			return result.$metadata.httpStatusCode === 200;
		} catch {
			return false;
		}
	}

	/**
	 * **DEPRECATED. This method will be remove in the next major version. Use `getCorsPolicies()` instead.**
	 *
	 * Returns Cross-Origin Resource Sharing (CORS) policies of the bucket.
	 * @deprecated
	 */
	public async getCors(): Promise<CORSPolicy[]> {
		return this.getCorsPolicies();
	}

	/**
	 * Returns Cross-Origin Resource Sharing (CORS) policies of the bucket.
	 */
	public async getCorsPolicies(): Promise<CORSPolicy[]> {
		try {
			const result = await this.r2.send(
				new GetBucketCorsCommand({
					Bucket: this.name,
				}),
			);

			const corsPolicies =
				result.CORSRules?.map((rule) => {
					const {
						AllowedHeaders: allowedHeaders,
						AllowedMethods: allowedMethods,
						AllowedOrigins: allowedOrigins,
						ExposeHeaders: exposeHeaders,
						ID: id,
						MaxAgeSeconds: maxAgeSeconds,
					} = rule;
					return {
						allowedHeaders,
						allowedMethods,
						allowedOrigins,
						exposeHeaders,
						id,
						maxAgeSeconds,
					};
				}) || [];

			return corsPolicies;
		} catch {
			return [];
		}
	}

	/**
	 * Returns the region the bucket resides in.
	 * @param bucketName
	 */
	public async getRegion() {
		const result = await this.r2.send(
			new GetBucketLocationCommand({
				Bucket: this.name,
			}),
		);
		return result.LocationConstraint || "auto";
	}

	/**
	 * Returns the encryption configuration of the bucket.
	 */
	public async getEncryption() {
		const result = await this.r2.send(
			new GetBucketEncryptionCommand({
				Bucket: this.name,
			}),
		);

		const rules =
			result.ServerSideEncryptionConfiguration?.Rules?.map((rule) => {
				return {
					applyServerSideEncryptionByDefault: {
						sseAlgorithm: rule.ApplyServerSideEncryptionByDefault?.SSEAlgorithm,
						kmsMasterKeyId: rule.ApplyServerSideEncryptionByDefault?.KMSMasterKeyID,
					},
					bucketKeyEnabled: rule.BucketKeyEnabled,
				};
			}) || [];

		return rules;
	}

	/**
	 * Upload a local file to the bucket. If the file already exists in the bucket, it will be overwritten.
	 * @param file File location.
	 * @param destination Name of the file to put in the bucket. If `destination` contains slash character(s), this will put the file inside directories.
	 * @param customMetadata Custom metadata to set to the uploaded file.
	 * @param mimeType Optional mime type. (Default: `application/octet-stream`)
	 */
	public async uploadFile(
		file: PathLike,
		destination?: string,
		customMetadata?: Record<string, string>,
		mimeType?: string,
	): Promise<UploadFileResponse> {
		const fileStream = createReadStream(file);
		try {
			const result = await this.upload(fileStream, destination || basename(file.toString()), customMetadata, mimeType);
			fileStream.close();
			return result;
		} catch (error) {
			fileStream.close();
			throw error;
		}
	}

	/**
	 * Upload an object to the bucket.
	 * @param contents The object contents to upload.
	 * @param destination The name of the file to put in the bucket. If `destination` contains slash character(s), this will put the file inside directories. If the file already exists in the bucket, it will be overwritten.
	 * @param customMetadata Custom metadata to set to the uploaded file.
	 * @param mimeType Optional mime type. (Default: `application/octet-stream`)
	 */
	public async upload(
		contents: string | Uint8Array | Buffer | Readable | ReadStream,
		destination: string,
		customMetadata?: Record<string, string>,
		mimeType?: string,
	): Promise<UploadFileResponse> {
		const normalizedDestination = this.normalizeDestination(destination);

		const result = await this.r2.send(
			new PutObjectCommand({
				Bucket: this.name,
				Key: normalizedDestination,
				Body: contents,
				ContentType: mimeType || "application/octet-stream",
				Metadata: customMetadata,
			}),
		);

		return {
			objectKey: normalizedDestination,
			uri: `${this.uri}/${normalizedDestination}`,
			publicUrl: this.generateObjectPublicUrl(normalizedDestination),
			publicUrls: this.generateObjectPublicUrls(normalizedDestination),
			etag: result.ETag,
			versionId: result.VersionId,
		};
	}

	/**
	 * Upload an object or stream to the bucket. This is a new method to put object to the bucket using multipart upload.
	 * @param contents The object contents to upload.
	 * @param destination The name of the file to put in the bucket. If `destination` contains slash character(s), this will put the file inside directories. If the file already exists in the bucket, it will be overwritten.
	 * @param customMetadata Custom metadata to set to the uploaded file.
	 * @param mimeType Optional mime type. (Default: `application/octet-stream`)
	 * @param onProgress A callback to handle progress data.
	 */
	public async uploadStream(
		contents: string | Uint8Array | Buffer | Readable | ReadStream,
		destination: string,
		customMetadata?: Record<string, string>,
		mimeType?: string,
		onProgress?: (progress: Progress) => void,
	): Promise<UploadFileResponse> {
		const normalizedDestination = this.normalizeDestination(destination);

		const upload = new Upload({
			client: this.r2,
			params: {
				Bucket: this.name,
				Key: normalizedDestination,
				Body: contents,
				ContentType: mimeType || "application/octet-stream",
				Metadata: customMetadata,
			},
		});

		if (onProgress) upload.on("httpUploadProgress", (progress) => onProgress(progress));

		const result = await upload.done();

		return {
			objectKey: normalizedDestination,
			uri: `${this.uri}/${normalizedDestination}`,
			publicUrl: this.generateObjectPublicUrl(normalizedDestination),
			publicUrls: this.generateObjectPublicUrls(normalizedDestination),
			etag: result.ETag,
			versionId: result.VersionId,
		};
	}

	/**
	 * **DEPRECATED. This method will be removed in the next major version. Use `deleteObject()` instead.**
	 *
	 * Deletes a file in the bucket.
	 * @param file
	 * @deprecated
	 */
	public async deleteFile(file: string) {
		return this.deleteObject(file);
	}

	/**
	 * Deletes an object in the bucket.
	 * @param objectKey
	 */
	public async deleteObject(objectKey: string) {
		const result = await this.r2.send(
			new DeleteObjectCommand({
				Bucket: this.name,
				Key: objectKey,
			}),
		);

		return (
			result.$metadata.httpStatusCode && result.$metadata.httpStatusCode >= 200 && result.$metadata.httpStatusCode < 300
		);
	}

	/**
	 * Retrieves metadata from an object without returning the object itself.
	 * @param objectKey
	 */
	public async headObject(objectKey: string): Promise<HeadObjectResponse> {
		const result = await this.r2.send(
			new HeadObjectCommand({
				Bucket: this.name,
				Key: objectKey,
			}),
		);

		return {
			lastModified: result.LastModified,
			contentLength: result.ContentLength,
			acceptRanges: result.AcceptRanges,
			etag: result.ETag,
			contentType: result.ContentType,
			customMetadata: result.Metadata,
		};
	}

	/**
	 * Returns some or all (up to 1,000) of the objects in the bucket with each request.
	 * @param maxResults The maximum number of objects to return per request. (Default: 1000)
	 * @param marker A token that specifies where to start the listing.
	 */
	public async listObjects(maxResults = 1000, marker?: string): Promise<ObjectListResponse> {
		const result = await this.r2.send(
			new ListObjectsCommand({
				Bucket: this.name,
				MaxKeys: maxResults,
				Marker: marker,
			}),
		);

		return {
			objects:
				result.Contents?.map((content) => {
					const {
						Key: key,
						LastModified: lastModified,
						ETag: etag,
						ChecksumAlgorithm: checksumAlgorithm,
						Size: size,
						StorageClass: storageClass,
					} = content;
					return {
						key,
						lastModified,
						etag,
						checksumAlgorithm,
						size,
						storageClass,
					};
				}) || [],
			continuationToken: result.Marker,
			nextContinuationToken: result.NextMarker,
		};
	}

	/**
	 * Copies an object from the current storage bucket to a new destination object in the same bucket.
	 * @param sourceObjectKey The key of the source object to be copied.
	 * @param destinationObjectKey The key of the destination object where the source object will be copied to.
	 */
	public async copyObject(sourceObjectKey: string, destinationObjectKey: string) {
		const result = await this.r2.send(
			new CopyObjectCommand({
				Bucket: this.name,
				CopySource: sourceObjectKey,
				Key: destinationObjectKey,
			}),
		);

		return result;
	}

	/**
	 * Checks if an object exists in the bucket.
	 * @param objectkey
	 */
	public async objectExists(objectkey: string): Promise<boolean> {
		try {
			const result = await this.headObject(objectkey);

			return !!result.contentLength;
		} catch {
			return false;
		}
	}

	/**
	 * Normalizes the destination path by removing leading forward slashes.
	 *
	 * @param {string} destination - The original destination path.
	 * @returns {string} The normalized destination path without leading slashes.
	 *
	 */
	private normalizeDestination(destination: string): string {
		return destination.startsWith("/") ? destination.replace(/^\/+/, "") : destination;
	}

	/**
	 * Sets tags for the bucket
	 * @param tags An array of key-value pairs
	 */
	public async setBucketTags(tags: Tag[]): Promise<void> {
		await this.r2.send(
			new PutBucketTaggingCommand({
				Bucket: this.name,
				Tagging: { TagSet: tags },
			}),
		);
	}

	/**
	 * Retrieves tags for the bucket
	 * @returns An array of key-value pairs
	 */
	public async getBucketTags(): Promise<Tag[]> {
		try {
			const result = await this.r2.send(
				new GetBucketTaggingCommand({
					Bucket: this.name,
				}),
			);
			return result.TagSet || [];
		} catch (error) {
			if ((error as Error).name === "NoSuchTagSet") {
				return [];
			}
			throw error;
		}
	}

	/**
	 * Removes all tags from the bucket
	 */
	public async deleteBucketTags(): Promise<void> {
		await this.r2.send(
			new DeleteBucketTaggingCommand({
				Bucket: this.name,
			}),
		);
	}

	/**
	 * Sets tags for an object
	 * @param objectKey The key of the object
	 * @param tags An array of key-value pairs
	 */
	public async setObjectTags(objectKey: string, tags: Tag[]): Promise<void> {
		await this.r2.send(
			new PutObjectTaggingCommand({
				Bucket: this.name,
				Key: objectKey,
				Tagging: { TagSet: tags },
			}),
		);
	}

	/**
	 * Retrieves tags for an object
	 * @param objectKey The key of the object
	 * @returns An array of key-value pairs
	 */
	public async getObjectTags(objectKey: string): Promise<Tag[]> {
		try {
			const result = await this.r2.send(
				new GetObjectTaggingCommand({
					Bucket: this.name,
					Key: objectKey,
				}),
			);
			return result.TagSet || [];
		} catch (error) {
			if ((error as Error).name === "NoSuchTagSet") {
				return [];
			}
			throw error;
		}
	}

	/**
	 * Removes all tags from an object
	 * @param objectKey The key of the object
	 */
	public async deleteObjectTags(objectKey: string): Promise<void> {
		await this.r2.send(
			new DeleteObjectTaggingCommand({
				Bucket: this.name,
				Key: objectKey,
			}),
		);
	}
}
