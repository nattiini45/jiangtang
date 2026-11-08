import QRCode from "qrcode";

/**
 * Server-side QR rendering (SVG string) for the room/equipment detail pages.
 * `.server.ts` so the node-oriented encoder never lands in the client bundle;
 * the pages pass the resulting SVG to a presentational component.
 */
export async function qrSvg(text: string, width = 168): Promise<string> {
  return QRCode.toString(text, {
    type: "svg",
    margin: 1,
    width,
    errorCorrectionLevel: "M",
  });
}
