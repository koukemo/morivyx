export class PackageError extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = "PackageError";
    this.code = code;
    this.path = path;
  }

  toIssue() {
    return {
      code: this.code,
      path: this.path,
      message: this.message,
    };
  }
}
