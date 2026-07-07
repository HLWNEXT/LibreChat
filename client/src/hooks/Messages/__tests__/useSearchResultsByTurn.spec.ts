import { renderHook } from '@testing-library/react';
import { Tools, TAttachment } from 'librechat-data-provider';
import { useSearchResultsByTurn } from '../useSearchResultsByTurn';

describe('useSearchResultsByTurn', () => {
  it('maps mcp_search attachments into the turn-indexed search results', () => {
    const attachments: TAttachment[] = [
      {
        type: Tools.mcp_search,
        messageId: 'msg1',
        toolCallId: 'tool1',
        conversationId: 'conv1',
        [Tools.mcp_search]: {
          turn: 0,
          references: [
            {
              link: 'https://hlw.atlassian.net/wiki/spaces/PD/pages/2107408385/Worksets',
              type: 'link',
              title: 'Worksets',
              snippet: 'This page identifies...',
            },
          ],
        },
      },
    ];

    const { result } = renderHook(() => useSearchResultsByTurn(attachments));

    expect(result.current['0']).toBeDefined();
    expect(result.current['0'].references).toHaveLength(1);
    expect(result.current['0'].references?.[0].title).toBe('Worksets');
  });

  it('returns an empty map when no attachments are provided', () => {
    const { result } = renderHook(() => useSearchResultsByTurn(undefined));
    expect(result.current).toEqual({});
  });
});
