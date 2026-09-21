export class GraphentraError extends Error {
  public readonly code: string;

  constructor(message: string, code: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = this.constructor.name;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class GitExecutionError extends GraphentraError {
  public readonly command: string;
  public readonly stderr: string;

  constructor(message: string, command: string, stderr: string = '') {
    super(message, 'GIT_EXECUTION_ERROR');
    this.command = command;
    this.stderr = stderr;
  }
}

export class GitNotFoundError extends GraphentraError {
  constructor(message: string = 'Git executable not found in PATH.') {
    super(message, 'GIT_NOT_FOUND');
  }
}

export class InvalidTargetError extends GraphentraError {
  constructor(targetPath: string, reason: string) {
    super(`Invalid target directory "${targetPath}": ${reason}`, 'INVALID_TARGET');
  }
}

export class RevisionError extends GraphentraError {
  constructor(message: string, code: 'INVALID_REVISION' | 'REVISION_MISMATCH' | 'MISSING_HISTORY' = 'INVALID_REVISION') {
    super(message, code);
  }
}

export class DirtySourceError extends GraphentraError {
  constructor(message: string, code: 'DIRTY_TRACKED_SOURCE' | 'DIRTY_UNTRACKED_SOURCE' = 'DIRTY_TRACKED_SOURCE') {
    super(message, code);
  }
}

export class BaselineSourceError extends GraphentraError {
  constructor(message: string) {
    super(message, 'BASELINE_SOURCE_FAILED');
  }
}

export class EvidenceValidationError extends GraphentraError {
  public readonly validationErrors: string[];

  constructor(validationErrors: string[]) {
    super(`Evidence validation failed:\n- ${validationErrors.join('\n- ')}`, 'EVIDENCE_VALIDATION_FAILED');
    this.validationErrors = validationErrors;
  }
}
