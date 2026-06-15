import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Readable, Writable } from "node:stream";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createReadStream: vi.fn(() => Readable.from(Buffer.from("test data"))),
    createWriteStream: vi.fn(() => new Writable({ write(_c, _e, cb) { cb(); } })),
  };
});

// ── Mock the S3 SDK loaded via createRequire ──────────────────────────────────

const mockSend = vi.fn();
const mockGetSignedUrl = vi.fn();

class MockS3Client { send = mockSend; }
class MockPutObjectCommand { constructor(public input: any) {} }
class MockGetObjectCommand { constructor(public input: any) {} }
class MockHeadObjectCommand { constructor(public input: any) {} }
class MockDeleteObjectCommand { constructor(public input: any) {} }

vi.mock("node:module", () => ({
  createRequire: () => (mod: string) => {
    if (mod === "@aws-sdk/client-s3") {
      return {
        S3Client: MockS3Client,
        PutObjectCommand: MockPutObjectCommand,
        GetObjectCommand: MockGetObjectCommand,
        HeadObjectCommand: MockHeadObjectCommand,
        DeleteObjectCommand: MockDeleteObjectCommand,
      };
    }
    if (mod === "@aws-sdk/s3-request-presigner") {
      return { getSignedUrl: mockGetSignedUrl };
    }
    throw new Error(`Unexpected require: ${mod}`);
  },
}));

vi.mock("node:child_process", () => ({ execSync: vi.fn() }));

const ENV_VARS = {
  ARTIFACT_S3_ENDPOINT: "https://s3.example.com",
  ARTIFACT_S3_REGION: "us-east-1",
  ARTIFACT_S3_KEY: "testkey",
  ARTIFACT_S3_SECRET: "testsecret",
  ARTIFACT_S3_BUCKET: "test-bucket",
};

describe("artifact-store", () => {
  let store: typeof import("./artifact-store.js");

  beforeEach(async () => {
    vi.resetModules();
    for (const [k, v] of Object.entries(ENV_VARS)) process.env[k] = v;
    mockSend.mockReset();
    mockGetSignedUrl.mockReset();
    store = await import("./artifact-store.js");
  });

  afterEach(() => {
    for (const k of Object.keys(ENV_VARS)) delete process.env[k];
  });

  // ── upload ────────────────────────────────────────────────────────────────

  describe("upload", () => {
    it("calls PutObjectCommand with correct Bucket/Key", async () => {
      mockSend.mockResolvedValue({});
      const url = await store.upload("/tmp/test.txt", "artifacts/test.txt");
      expect(mockSend).toHaveBeenCalledOnce();
      const cmd = mockSend.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(MockPutObjectCommand);
      expect(cmd.input.Bucket).toBe("test-bucket");
      expect(cmd.input.Key).toBe("artifacts/test.txt");
      expect(url).toBe("https://s3.example.com/test-bucket/artifacts/test.txt");
    });
  });

  // ── download ──────────────────────────────────────────────────────────────

  describe("download", () => {
    it("calls GetObjectCommand and pipes to file", async () => {
      const body = Readable.from(Buffer.from("hello"));
      mockSend.mockResolvedValue({ Body: body });

      await store.download("artifacts/test.txt", "/tmp/art-test-out.txt");
      expect(mockSend).toHaveBeenCalledOnce();
      const cmd = mockSend.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(MockGetObjectCommand);
      expect(cmd.input.Bucket).toBe("test-bucket");
      expect(cmd.input.Key).toBe("artifacts/test.txt");
    });
  });

  // ── presign ───────────────────────────────────────────────────────────────

  describe("presign", () => {
    it("calls getSignedUrl with correct expiry", async () => {
      mockGetSignedUrl.mockResolvedValue("https://signed.example.com/file?token=abc");
      const url = await store.presign("artifacts/test.txt", 7200);
      expect(mockGetSignedUrl).toHaveBeenCalledOnce();
      const [, , opts] = mockGetSignedUrl.mock.calls[0];
      expect(opts.expiresIn).toBe(7200);
      expect(url).toBe("https://signed.example.com/file?token=abc");
    });
  });

  // ── exists ────────────────────────────────────────────────────────────────

  describe("exists", () => {
    it("returns true on success", async () => {
      mockSend.mockResolvedValue({});
      expect(await store.exists("artifacts/test.txt")).toBe(true);
    });

    it("returns false on error", async () => {
      mockSend.mockRejectedValue(new Error("NotFound"));
      expect(await store.exists("artifacts/test.txt")).toBe(false);
    });
  });

  // ── remove ────────────────────────────────────────────────────────────────

  describe("remove", () => {
    it("calls DeleteObjectCommand", async () => {
      mockSend.mockResolvedValue({});
      await store.remove("artifacts/test.txt");
      expect(mockSend).toHaveBeenCalledOnce();
      const cmd = mockSend.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(MockDeleteObjectCommand);
      expect(cmd.input.Key).toBe("artifacts/test.txt");
    });
  });

  // ── not configured ────────────────────────────────────────────────────────

  describe("not configured", () => {
    beforeEach(() => {
      delete process.env["ARTIFACT_S3_ENDPOINT"];
    });

    it("upload throws", async () => {
      await expect(store.upload("/tmp/x", "k")).rejects.toThrow("Artifact store not configured");
    });

    it("download throws", async () => {
      await expect(store.download("k", "/tmp/x")).rejects.toThrow("Artifact store not configured");
    });

    it("presign throws", async () => {
      await expect(store.presign("k")).rejects.toThrow("Artifact store not configured");
    });

    it("exists throws", async () => {
      await expect(store.exists("k")).rejects.toThrow("Artifact store not configured");
    });

    it("remove throws", async () => {
      await expect(store.remove("k")).rejects.toThrow("Artifact store not configured");
    });
  });
});
