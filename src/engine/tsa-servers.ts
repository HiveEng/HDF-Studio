// Kept apart from tsa.ts so the UI can list servers without loading the crypto code.
/** Well-known free timestamp servers (RFC 3161). */
export const TSA_SERVERS = [
  { name: "DigiCert", url: "http://timestamp.digicert.com" },
  { name: "Sectigo", url: "http://timestamp.sectigo.com" },
  { name: "GlobalSign", url: "http://timestamp.globalsign.com/tsa/r6advanced1" },
  { name: "FreeTSA", url: "https://freetsa.org/tsr" },
];
