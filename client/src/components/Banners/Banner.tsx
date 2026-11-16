import { XIcon } from 'lucide-react';
import { useRecoilState } from 'recoil';
import { Button, cn } from '@librechat/client';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  CONFIG_HTML_TEXT_TAGS,
  CONFIG_HTML_CLASS_ATTR,
  createConfigHtmlSanitizer,
} from '~/utils/configHtml';
import { useGetBannerQuery } from '~/data-provider';
import store from '~/store';

const MIN_SCROLL_SECONDS = 10;
const SCROLL_PX_PER_SECOND = 60;

export const Banner = ({ onHeightChange }: { onHeightChange?: (height: number) => void }) => {
  const { data: banner } = useGetBannerQuery();
  const [hideBannerHint, setHideBannerHint] = useRecoilState<string[]>(store.hideBannerHint);
  const bannerRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [scrollDuration, setScrollDuration] = useState<number | null>(null);
  const sanitize = useMemo(
    () =>
      createConfigHtmlSanitizer({
        allowedTags: CONFIG_HTML_TEXT_TAGS,
        allowedAttr: CONFIG_HTML_CLASS_ATTR,
      }),
    [],
  );

  const sanitizedMessage = useMemo(() => {
    if (!banner?.message) {
      return '';
    }
    return sanitize(banner.message);
  }, [banner?.message, sanitize]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const text = textRef.current;
    if (!container || !text) {
      return;
    }
    const measure = () => {
      const overflowing = text.offsetWidth > container.clientWidth;
      setScrollDuration(
        overflowing ? Math.max(MIN_SCROLL_SECONDS, text.offsetWidth / SCROLL_PX_PER_SECOND) : null,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(text);
    return () => observer.disconnect();
  }, [sanitizedMessage, banner]);

  useEffect(() => {
    if (onHeightChange && bannerRef.current) {
      onHeightChange(bannerRef.current.offsetHeight);
    }
  }, [banner, hideBannerHint, onHeightChange]);

  if (
    !banner ||
    (banner.bannerId && !banner.persistable && hideBannerHint.includes(banner.bannerId))
  ) {
    return null;
  }

  const onClick = () => {
    if (banner.persistable) {
      return;
    }

    setHideBannerHint([...hideBannerHint, banner.bannerId]);

    if (onHeightChange) {
      onHeightChange(0);
    }
  };

  return (
    <div
      ref={bannerRef}
      className="sticky top-0 z-20 flex items-center bg-presentation px-2 py-1 text-text-primary dark:bg-gradient-to-r md:relative"
    >
      <div
        ref={containerRef}
        className={cn(
          'text-md w-full overflow-hidden whitespace-nowrap text-center [&_a]:text-blue-700 [&_a]:underline dark:[&_a]:text-blue-400',
          !banner.persistable && 'px-4',
        )}
      >
        <div
          ref={textRef}
          className={cn('inline-block', scrollDuration != null && 'banner-marquee')}
          style={scrollDuration != null ? { animationDuration: `${scrollDuration}s` } : undefined}
          dangerouslySetInnerHTML={{ __html: sanitizedMessage }}
        ></div>
      </div>
      {!banner.persistable && (
        <Button
          size="icon"
          variant="ghost"
          aria-label="Dismiss banner"
          className="size-8"
          onClick={onClick}
        >
          <XIcon className="mx-auto h-4 w-4 text-text-primary" aria-hidden="true" />
        </Button>
      )}
    </div>
  );
};
