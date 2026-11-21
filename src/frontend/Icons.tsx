import type { ComponentPropsWithRef } from "react";

const paths = {
  star: <path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z" />,
  edit: <path d="m15 5 4 4M4 20l4.5-1 11-11a2.8 2.8 0 0 0-4-4l-11 11L4 20Z" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5m0-8h.01" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  close: <path d="m6 6 12 12M18 6 6 18" />,
  album: (
    <>
      <path d="M5 7V4h14v3" />
      <rect x="3" y="8" width="18" height="12" rx="2" />
      <path d="m6 17 4-4 3 3 2-2 3 3" />
    </>
  ),
  addAlbum: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M12 9v6m-3-3h6" />
    </>
  ),
  revert: (
    <>
      <path d="M9 5 4 10l5 5m-5-5h10a5 5 0 0 1 0 10h-3" />
    </>
  ),
  write: (
    <>
      <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5Zm0 0v5h5m-7 2v7m-3-3 3 3 3-3" />
    </>
  ),
  map: <path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Zm6-3v15m6-12v15" />,
  plus: <path d="M12 5v14M5 12h14" />,
  back: <path d="m11 5-7 7 7 7M4 12h16" />,
  trash: <path d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13m-8 4v5m4-5v5" />,
};

export function Icon({ name }: { name: keyof typeof paths }) {
  return (
    <svg
      className="ui-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}

export function IconButton({
  name,
  label,
  className = "",
  ...props
}: ComponentPropsWithRef<"button"> & {
  name: keyof typeof paths;
  label: string;
}) {
  return (
    <button type="button" className={`btn icon-btn ${className}`} aria-label={label} data-tooltip={label} {...props}>
      <Icon name={name} />
    </button>
  );
}
