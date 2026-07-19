const STAGES = new Set([
  "validate-input",
  "resolve-build-roots",
  "prepare-build-checkout",
  "install-development",
  "build",
  "prepare-assembly",
  "seal-release-config",
  "create-archive",
  "measure-archive",
  "encode-descriptor",
  "publish-local",
  "candidate-build",
]);
const CODES = new Set([
  "invalid-input",
  "operation-failed",
  "work-root-exists",
  "work-parent-alias",
  "work-root-create-failed",
  "clone-source-failed",
  "checkout-source-failed",
  "tag-kind-read-failed",
  "tag-commit-read-failed",
  "tag-not-annotated",
  "tag-commit-mismatch",
  "root-overlap",
  "unclassified-failure",
]);

export class CandidateBuildFailure extends Error {
  constructor(stage, code, options = {}) {
    if (!STAGES.has(stage) || !CODES.has(code)) {
      throw new TypeError("Unsupported candidate build failure classification");
    }
    super(`${stage}:${code}`, options);
    this.name = "CandidateBuildFailure";
    Object.defineProperties(this, {
      stage: { value: stage, enumerable: true },
      code: { value: code, enumerable: true },
    });
  }
}

export function classifyCandidateBuildFailure(error, stage, code) {
  if (
    error instanceof CandidateBuildFailure &&
    STAGES.has(error.stage) &&
    CODES.has(error.code)
  ) {
    return error;
  }
  return new CandidateBuildFailure(stage, code, { cause: error });
}

export function encodeCandidateBuildFailure(error) {
  const failure =
    error instanceof CandidateBuildFailure &&
    STAGES.has(error.stage) &&
    CODES.has(error.code)
      ? error
      : new CandidateBuildFailure("candidate-build", "unclassified-failure", {
          cause: error,
        });
  return Buffer.from(
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "home-worker-candidate-build-failure",
      stage: failure.stage,
      code: failure.code,
    })}\n`,
    "utf8",
  );
}
