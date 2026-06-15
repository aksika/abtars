/**
 * artifact-store.ts — S3-compatible artifact store with lazy SDK loading (#929).
 */

import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { homedir } from "node:os";
import { Readable } from "node:stream";

const LIB_DIR = join(process.env["ABTARS_HOME"] ?? join(homedir(), ".abtars"), "lib");
const localRequire = createRequire(join(LIB_DIR, "node_modules", "_placeholder.js"));

let _s3: any;
let _presigner: any;

function loadSdk(): void {
  if (_s3) return;
  try {
    _s3 = localRequire("@aws-sdk/client-s3");
    _presigner = localRequire("@aws-sdk/s3-request-presigner");
  } catch {
    execSync(`npm install --prefix "${LIB_DIR}" @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`, { stdio: "pipe" });
    _s3 = localRequire("@aws-sdk/client-s3");
    _presigner = localRequire("@aws-sdk/s3-request-presigner");
  }
}

function getClient(): any {
  const endpoint = process.env["ARTIFACT_S3_ENDPOINT"];
  if (!endpoint) throw new Error("Artifact store not configured");
  loadSdk();
  return new _s3.S3Client({
    endpoint,
    region: process.env["ARTIFACT_S3_REGION"] || "auto",
    credentials: { accessKeyId: process.env["ARTIFACT_S3_KEY"] ?? "", secretAccessKey: process.env["ARTIFACT_S3_SECRET"] ?? "" },
  });
}

function bucket(): string {
  return process.env["ARTIFACT_S3_BUCKET"] || "abtars-artifacts";
}

export async function upload(localPath: string, remotePath: string): Promise<string> {
  const client = getClient();
  const stream = createReadStream(localPath);
  await client.send(new _s3.PutObjectCommand({ Bucket: bucket(), Key: remotePath, Body: stream }));
  return `${process.env["ARTIFACT_S3_ENDPOINT"]}/${bucket()}/${remotePath}`;
}

export async function download(remotePath: string, localPath: string): Promise<void> {
  const client = getClient();
  const resp = await client.send(new _s3.GetObjectCommand({ Bucket: bucket(), Key: remotePath }));
  await pipeline(resp.Body as Readable, createWriteStream(localPath));
}

export async function presign(remotePath: string, expiresIn = 3600): Promise<string> {
  const client = getClient();
  const cmd = new _s3.GetObjectCommand({ Bucket: bucket(), Key: remotePath });
  return _presigner.getSignedUrl(client, cmd, { expiresIn });
}

export async function exists(remotePath: string): Promise<boolean> {
  const client = getClient();
  try {
    await client.send(new _s3.HeadObjectCommand({ Bucket: bucket(), Key: remotePath }));
    return true;
  } catch { return false; }
}

export async function remove(remotePath: string): Promise<void> {
  const client = getClient();
  await client.send(new _s3.DeleteObjectCommand({ Bucket: bucket(), Key: remotePath }));
}
