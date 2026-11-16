import {
  buildWebSearchContext,
  buildCitationFormatContext,
  buildWebSearchDynamicContext,
} from './web';

jest.mock('librechat-data-provider', () => ({
  Tools: { web_search: 'web_search' },
  replaceSpecialVars: jest.fn(({ now }: { now?: string }) => now ?? 'NOW'),
}));

describe('web search context', () => {
  it('keeps static context free of volatile date replacements', () => {
    const context = buildWebSearchContext();

    expect(context).toContain('web_search');
    expect(context).not.toContain('NOW');
    expect(context).not.toContain('{{iso_datetime}}');
  });

  it('builds dynamic context from the supplied conversation anchor', () => {
    const context = buildWebSearchDynamicContext('2024-01-02T03:04:05.000Z');
    const secondContext = buildWebSearchDynamicContext('2024-01-02T03:04:05.000Z');

    expect(context).toBe(
      '# `web_search` Runtime Context\nConversation Date & Time: 2024-01-02T03:04:05.000Z',
    );
    expect(secondContext).toBe(context);
  });
});

describe('citation format context', () => {
  it('documents the escape-sequence anchor format, independent of web_search', () => {
    const context = buildCitationFormatContext();

    expect(context).toContain('\\ue202turn{N}{type}{index}');
    expect(context).not.toContain('web_search');
  });

  it('is embedded verbatim inside the web search context', () => {
    expect(buildWebSearchContext()).toContain(buildCitationFormatContext());
  });
});
