import React from 'react'

export interface CadenceLogoProps extends React.SVGProps<SVGSVGElement> {
  /**
   * Optional visual variant:
   * - 'currentColor': inherits CSS text color (default)
   * - 'gold': Champagne Gold (#D4AF37)
   * - 'white': Studio White (#F5F5F7)
   */
  variant?: 'currentColor' | 'gold' | 'white'
}

export const CadenceLogo: React.FC<CadenceLogoProps> = ({
  variant = 'currentColor',
  className = 'w-4 h-4',
  ...props
}) => {
  const fillColor =
    variant === 'gold'
      ? '#D4AF37'
      : variant === 'white'
      ? '#F5F5F7'
      : 'currentColor'

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 512"
      fill="none"
      className={className}
      aria-label="Cadence Logo"
      {...props}
    >
      <path
        fill={fillColor}
        d="M 356.57 320.78 L 336.73 300.93 A 78.79 78.79 0 1 1 336.73 211.07 L 389.72 158.07 A 153.13 153.13 0 1 0 370.26 373.45 L 383.64 386.83 A 171.99 171.99 0 1 1 403.11 144.69 L 422.97 124.82 A 200.0 200.0 0 1 0 422.97 387.18 L 370.01 334.21 A 125.39 125.39 0 1 1 350.55 158.26 L 337.12 171.69 A 106.53 106.53 0 1 0 356.57 320.78 Z"
      />
    </svg>
  )
}

export default CadenceLogo

