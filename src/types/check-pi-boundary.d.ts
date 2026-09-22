// Ambient types for the check-pi-boundary.mjs script, imported for fixture
// exercise by pi-boundary.test.ts. The script is plain JS (checked in as a
// dev-time guard, not bundled), so the test project needs these declarations.
// Suffix-wildcard form: under moduleResolution Node16 a relative ambient name
// does not match the import, so this is the narrowest working pattern — it
// matches only this script's specifier. Keep in sync with its exports.
declare module "*check-pi-boundary.mjs" {
  export interface PiBoundaryViolation {
    file: string;
    line: number;
    specifier: string;
    kind?: string;
  }
  export function checkPiBoundarySource(sourceText: string, fileName: string): PiBoundaryViolation[];
  export function checkPiImportSurface(
    sourceText: string,
    fileName: string,
    relPath: string,
  ): PiBoundaryViolation[];
}
