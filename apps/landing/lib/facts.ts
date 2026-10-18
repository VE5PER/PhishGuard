export interface ProductFacts {
  extensionVersion: string;
  extensionId: string;
  zipSha256: string;
  zipSize: string;
  crxSha256: string;
  crxSize: string;
  modelVersion: string;
  modelSha256: string;
  accuracy: number;
  modelSizeBytes: number;
  accuracyGate: number;
  teacherAccuracyGate: number;
  visionInput: string;
  screenshotUpload: string;
}

export const DEFAULT_FACTS: ProductFacts = {
  extensionVersion: "0.5.18",
  extensionId: "loanjnnlfhechkonbjelmbdacmmcbagg",
  zipSha256: "92e396218d9b3d90bf6af1a710aa4186415748fb7a4187454467a4ce3ee80e41",
  zipSize: "7.03 MB",
  crxSha256: "403d4bf2dea8a64fc6aa271f6d1938fc0fd731c66d4bb4fb8882ff69699bf369",
  crxSize: "7.05 MB",
  modelVersion: "2.0.0",
  modelSha256: "7b5d1fcb1d945c0c0e5101f264bd948ab31487a17df4a5f30690c63a2f4878c7",
  accuracy: 1.0,
  modelSizeBytes: 167327,
  accuracyGate: 0.95,
  teacherAccuracyGate: 0.98,
  visionInput: "64×64",
  screenshotUpload: "full-size",
};

export const fmtKB = (bytes: number): string => `${Math.round(bytes / 1000)} KB`;

export const fmtMB = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

export const fmtPct = (ratio: number): string => `${Number((ratio * 100).toFixed(1))}%`;
