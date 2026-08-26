import fs from 'node:fs/promises';
import path from 'node:path';

const MEDIA_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif']
]);

function requireAttachments(ctx) {
  const attachments = ctx?.get?.('attachments');
  if (!attachments?.saveImages) throw new Error('DSHX image input requires DSH service: attachments.saveImages');
  return attachments;
}

function localMediaType(filePath) {
  const mediaType = MEDIA_TYPES.get(path.extname(filePath).toLowerCase());
  if (!mediaType) throw new Error(`Unsupported local image type: ${path.extname(filePath) || '<none>'}`);
  return mediaType;
}

function parseDataImage(url) {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(String(url ?? ''));
  if (!match) return undefined;
  return {
    mediaType: match[1].toLowerCase(),
    data: Buffer.from(match[2].replace(/[\r\n]/g, ''), 'base64')
  };
}

function skillGesture(name) {
  const value = String(name ?? '');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new Error(`Invalid DSH skill name from Codex input: ${JSON.stringify(name)}`);
  }
  return `/${value}`;
}

/**
 * Convert pinned Codex UserInput into the public DSH UserContent vocabulary.
 * Images are committed through DSH's attachment service before their refs are
 * placed in the durable user message. User-explicit skills deliberately remain
 * plain `/name` gestures because that is DSH's authoritative pre-step seam.
 */
export async function codexInputToDshContent(ctx, inputs = []) {
  if (!Array.isArray(inputs)) throw new Error('Codex input must be an array');
  const plan = [];
  const pendingImages = [];

  for (const input of inputs) {
    switch (input?.type) {
      case 'text':
        if (typeof input.text !== 'string') throw new Error('Codex text input requires text');
        plan.push({ kind: 'content', block: { type: 'text', text: input.text } });
        break;
      case 'skill':
        plan.push({ kind: 'content', block: { type: 'text', text: skillGesture(input.name) } });
        break;
      case 'localImage': {
        if (typeof input.path !== 'string' || input.path.length === 0) {
          throw new Error('Codex localImage input requires path');
        }
        const filePath = path.resolve(input.path);
        const mediaType = localMediaType(filePath);
        const data = await fs.readFile(filePath);
        const imageIndex = pendingImages.length;
        pendingImages.push({ data, mediaType, name: path.basename(filePath) });
        plan.push({ kind: 'image', imageIndex });
        break;
      }
      case 'image': {
        const inline = parseDataImage(input.url);
        if (!inline) {
          throw new Error('DSHX accepts Codex image input only as localImage or data:image/*; remote image URLs remain provider-owned');
        }
        const imageIndex = pendingImages.length;
        pendingImages.push({ ...inline, name: `pasted-image-${imageIndex + 1}` });
        plan.push({ kind: 'image', imageIndex });
        break;
      }
      case 'mention':
        throw new Error('DSHX does not yet project Codex structured mentions into a DSH user message');
      default:
        throw new Error(`Unsupported Codex user input type: ${JSON.stringify(input?.type)}`);
    }
  }

  const refs = pendingImages.length > 0
    ? await requireAttachments(ctx).saveImages(pendingImages)
    : [];
  return plan.map((entry) => entry.kind === 'image'
    ? { type: 'image', ref: refs[entry.imageIndex] }
    : entry.block);
}

export function dshContentText(content = []) {
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

export const inputInternals = { localMediaType, parseDataImage, skillGesture };
