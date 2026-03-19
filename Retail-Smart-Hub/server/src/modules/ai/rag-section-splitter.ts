export interface SectionBlock {
  title: string;
  content: string;
}

export function normalizeText(content: string) {
  return content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
}

function isMarkdownHeading(line: string) {
  return /^#{1,6}\s+/.test(line.trim());
}

function toPlainSectionTitle(line: string) {
  return line.trim().replace(/^#{1,6}\s+/, '').trim();
}

export function splitMarkdownSections(content: string): SectionBlock[] {
  const lines = content.split('\n');
  const sections: SectionBlock[] = [];
  let currentTitle = 'Overview';
  let buffer: string[] = [];

  const flush = () => {
    const sectionContent = buffer.join('\n').trim();
    if (!sectionContent) {
      buffer = [];
      return;
    }
    sections.push({
      title: currentTitle,
      content: sectionContent,
    });
    buffer = [];
  };

  for (const line of lines) {
    if (isMarkdownHeading(line)) {
      flush();
      currentTitle = toPlainSectionTitle(line);
      continue;
    }
    buffer.push(line);
  }
  flush();
  return sections.length > 0 ? sections : [{ title: 'Overview', content }];
}

export function splitPlainTextSections(content: string): SectionBlock[] {
  const blocks = content
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (blocks.length === 0) {
    return [{ title: 'Overview', content }];
  }

  return blocks.map((block, index) => ({
    title: index === 0 ? 'Overview' : `Block ${index + 1}`,
    content: block,
  }));
}

export function splitIntoParagraphs(content: string) {
  return content
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function splitLongParagraph(paragraph: string, minChunkLength: number, maxChunkLength: number) {
  if (paragraph.length <= maxChunkLength) {
    return [paragraph];
  }

  const lines = paragraph
    .split(/(?<=[\u3002\uFF01\uFF1F\uFF1B.!?])\s*/g)
    .map((item) => item.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    const candidate = current ? `${current} ${line}` : line;
    if (candidate.length <= maxChunkLength || current.length < minChunkLength) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
    }
    current = line;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks.length > 0 ? chunks : [paragraph];
}
