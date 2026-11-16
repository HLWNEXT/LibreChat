import React from 'react';

const SocialButton = ({ id, enabled, serverDomain, oauthPath, Icon, label }) => {
  if (!enabled) {
    return null;
  }

  return (
    <div className="mt-2 flex gap-x-2">
      <a
        aria-label={`${label}`}
        className={`flex w-full items-center rounded-2xl border border-border-light bg-surface-primary px-5 py-3 text-text-primary transition-colors duration-200 hover:bg-surface-tertiary${Icon ? ' space-x-3' : ' justify-center'}`}
        href={`${serverDomain}/oauth/${oauthPath}`}
        data-testid={id}
      >
        {Icon && <Icon />}
        <p>{label}</p>
      </a>
    </div>
  );
};

export default SocialButton;
