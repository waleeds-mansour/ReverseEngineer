// Nook's wordmark: the mark and the word Nook (design/nook/assets/Logos/nook-wordmark.svg). The
// mark keeps the Light theme's blue on any surface; the word takes the window's text colour, so
// it reads in the dark theme too.

const BLUE = "#0a60c8";
/** A name, not words to translate. */
const NAME = "Nook";

const NookWordmark = ({
  width,
  className,
}: {
  width?: number;
  className?: string;
}) => (
  <svg
    width={width}
    viewBox="0 0 220 64"
    className={`text-text ${className ?? ""}`}
    xmlns="http://www.w3.org/2000/svg"
    role="img"
    aria-label="Nook"
  >
    <rect width="64" height="64" rx="16" fill={BLUE} />
    <rect
      x="10"
      y="12"
      width="30"
      height="26"
      rx="7"
      fill="#fff"
      opacity=".4"
    />
    <rect x="22" y="24" width="32" height="28" rx="8" fill="#fff" />
    <circle cx="33" cy="37" r="3.5" fill={BLUE} />
    <circle cx="43" cy="37" r="3.5" fill={BLUE} />
    <path
      d="M36 44q2 2 4 0"
      fill="none"
      stroke={BLUE}
      strokeWidth="2"
      strokeLinecap="round"
    />
    <text
      x="80"
      y="46"
      fontFamily="-apple-system,BlinkMacSystemFont,'SF Pro Display','Segoe UI Variable Display','Segoe UI',system-ui,sans-serif"
      fontWeight="700"
      fontSize="40"
      letterSpacing="-1.5"
      fill="currentColor"
    >
      {NAME}
    </text>
  </svg>
);

export default NookWordmark;
