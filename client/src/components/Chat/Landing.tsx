import { useMemo, useCallback, useState, useEffect, useRef } from 'react';
import { HatGlasses } from 'lucide-react';
import { EModelEndpoint } from 'librechat-data-provider';
import { BirthdayIcon, TooltipAnchor, useRemScale } from '@librechat/client';
import type { AnimationEvent } from 'react';
import { useChatContext, useAgentsMapContext, useAssistantsMapContext } from '~/Providers';
import Description, { isHtmlDescription } from '~/components/ui/Description';
import { useGetEndpointsQuery, useGetStartupConfig } from '~/data-provider';
import { getIconEndpoint, getEntity, getModelSpec } from '~/utils';
import { useLocalize, useAuthContext, useGreeting } from '~/hooks';
import { useChatSettings } from '~/Providers/ChatSettingsContext';
import AgentContact from '~/components/Agents/AgentContact';
import ConvoIcon from '~/components/Endpoints/ConvoIcon';
import { announceGreetingSettled } from './welcome';

const containerClassName =
  'relative flex h-full items-center justify-center rounded-full bg-presentation text-text-primary';

function getTextSizeClass(text: string | undefined | null) {
  if (!text) {
    return 'text-xl sm:text-2xl';
  }

  if (text.length < 56) {
    return 'text-2xl sm:text-4xl';
  }

  if (text.length < 70) {
    return 'text-xl sm:text-2xl';
  }

  return 'text-lg sm:text-base';
}

export default function Landing({ centerFormOnLanding }: { centerFormOnLanding: boolean }) {
  const { conversation } = useChatContext();
  const agentsMap = useAgentsMapContext();
  const assistantMap = useAssistantsMapContext();
  const { data: startupConfig } = useGetStartupConfig();
  const { data: endpointsConfig } = useGetEndpointsQuery();
  const { user } = useAuthContext();
  const localize = useLocalize();
  const remScale = useRemScale();
  const { isTemporary } = useChatSettings();

  const textHasMultipleLines = false;
  const lineCount = 1;
  const [contentHeight, setContentHeight] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);

  const endpointType = useMemo(() => {
    let ep = conversation?.endpoint ?? '';
    if (ep === EModelEndpoint.azureOpenAI) {
      ep = EModelEndpoint.openAI;
    }
    return getIconEndpoint({
      endpointsConfig,
      iconURL: conversation?.iconURL,
      endpoint: ep,
    });
  }, [conversation?.endpoint, conversation?.iconURL, endpointsConfig]);

  const { entity, isAgent } = getEntity({
    endpoint: endpointType,
    agentsMap,
    assistantMap,
    agent_id: conversation?.agent_id,
    assistant_id: conversation?.assistant_id,
  });

  const modelSpec = useMemo(
    () => getModelSpec({ specName: conversation?.spec, startupConfig }),
    [conversation?.spec, startupConfig],
  );

  const brandedSpecLabel = modelSpec?.showOnLanding ? modelSpec.label : '';
  const brandedSpecDescription = (modelSpec?.showOnLanding && modelSpec.description) || '';
  const name =
    isTemporary || startupConfig?.interface?.landingHeading === 'greeting'
      ? ''
      : (entity?.name ?? brandedSpecLabel);
  const description = isTemporary
    ? localize('com_ui_temporary_description')
    : ((entity?.description || brandedSpecDescription || conversation?.greeting) ?? '');
  const descriptionIsHTML = isHtmlDescription(description);
  const selectedAgent =
    isAgent && conversation?.agent_id != null ? agentsMap?.[conversation.agent_id] : undefined;

  const customWelcome =
    typeof startupConfig?.interface?.customWelcome === 'string'
      ? startupConfig.interface.customWelcome
      : undefined;

  const scheduledGreeting = useGreeting(user?.name);

  /** The greeting animates a grapheme at a time; when the last one settles the
   * screen comes alive from that character (the composer takes focus, and a
   * welcome backdrop can answer) instead of the title simply stopping. Once per
   * visit: the title remounts when its text changes, such as an agent's name
   * arriving after the time-based greeting has settled, and the screen has
   * already come alive by then. */
  const settledAnnounced = useRef(false);
  const handleTitleSettled = useCallback((event: AnimationEvent<HTMLElement>) => {
    if (settledAnnounced.current) {
      return;
    }
    settledAnnounced.current = true;
    const range = document.createRange();
    range.selectNodeContents(event.currentTarget);
    const { left, top, width, height } = range.getBoundingClientRect();
    announceGreetingSettled(left + width, top + height / 2);
  }, []);

  useEffect(() => {
    if (contentRef.current) {
      setContentHeight(contentRef.current.offsetHeight);
    }
  }, [lineCount, description, selectedAgent, remScale]);

  const getDynamicMargin = useMemo(() => {
    let margin = 'mb-0';

    if (lineCount > 2 || (description && description.length > 100)) {
      margin = 'mb-10';
    } else if (lineCount > 1 || (description && description.length > 0)) {
      margin = 'mb-6';
    } else if (textHasMultipleLines) {
      margin = 'mb-4';
    }

    if (contentHeight > 200) {
      margin = 'mb-16';
    } else if (contentHeight > 150) {
      margin = 'mb-12';
    }

    return margin;
  }, [lineCount, description, textHasMultipleLines, contentHeight]);

  const resolvedWelcome =
    customWelcome != null && user?.name
      ? customWelcome.replace(/{{user.name}}/g, user.name)
      : customWelcome;

  const greetingText = isTemporary
    ? localize('com_ui_temporary')
    : (resolvedWelcome ?? scheduledGreeting);

  return (
    <div
      className={`flex h-full transform-gpu flex-col items-center justify-center pb-16 transition-all duration-200 ${centerFormOnLanding ? 'max-h-full sm:max-h-0' : 'max-h-full'} ${getDynamicMargin}`}
    >
      <div ref={contentRef} className="flex flex-col items-center gap-0 p-2">
        <div
          className={`flex ${textHasMultipleLines ? 'flex-col' : 'flex-col md:flex-row'} items-center justify-center gap-2`}
        >
          <div className={`relative size-10 justify-center ${textHasMultipleLines ? 'mb-2' : ''}`}>
            <div className="avatar-stroke size-full rounded-full dark:after:shadow-none">
              {isTemporary ? (
                <div className={containerClassName}>
                  <HatGlasses className="text-text-primary h-2/3 w-2/3" aria-hidden="true" />
                </div>
              ) : (
                <ConvoIcon
                  agentsMap={agentsMap}
                  assistantMap={assistantMap}
                  conversation={conversation}
                  endpointsConfig={endpointsConfig}
                  containerClassName={containerClassName}
                  context="landing"
                  className="text-text-primary h-2/3 w-2/3"
                  size={41}
                />
              )}
            </div>
            {startupConfig?.showBirthdayIcon && (
              <TooltipAnchor
                className="absolute inset-e-2 bottom-[1.6875rem]"
                description={localize('com_ui_happy_birthday')}
                aria-label={localize('com_ui_happy_birthday')}
              >
                <BirthdayIcon />
              </TooltipAnchor>
            )}
          </div>
          {name ? (
            <div className="flex flex-col items-center gap-0 p-2">
              <p
                key={`agent-name-${name}`}
                onAnimationEnd={handleTitleSettled}
                className={`animate-fadeIn ${getTextSizeClass(name)} text-text-primary text-center font-medium`}
              >
                {name}
              </p>
            </div>
          ) : (
            <p
              key={`greeting-${greetingText}`}
              onAnimationEnd={handleTitleSettled}
              className={`animate-fadeIn ${getTextSizeClass(greetingText)} text-text-primary text-center font-medium`}
            >
              {greetingText}
            </p>
          )}
        </div>
        <Description
          allowMedia
          description={description}
          className={
            descriptionIsHTML
              ? 'animate-fadeIn text-text-primary mt-4 flex max-w-md items-center justify-center gap-2 text-center text-sm font-normal [&_img]:inline-block [&_img]:h-4 [&_img]:w-4'
              : `animate-fadeIn mt-4 max-w-md text-center text-sm font-normal ${isTemporary ? 'text-text-secondary' : 'text-text-primary'}`
          }
        />
        {selectedAgent && !isTemporary && (
          <AgentContact
            agent={selectedAgent}
            className="animate-fadeIn mt-2 max-w-md justify-center text-center text-sm"
          />
        )}
      </div>
    </div>
  );
}
