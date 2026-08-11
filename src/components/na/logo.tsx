interface LogoProps {
  size?: number
}

/**
 * 可交互 Logo：鼠标触碰时呈现「信号干扰」效果。
 * 通过叠加两层切片副本 + 一层 SVG 噪点实现，效果动画见 assets/main.css 的 .na-logo 系列。
 */
export function Logo({ size = 112 }: LogoProps) {
  return (
    <div className="na-logo shrink-0" style={{ width: size, height: size }}>
      <img src="./Logo.png" alt="NA" className="na-logo-main" />
      <img src="./Logo.png" alt="" aria-hidden className="na-logo-slice na-logo-slice-a" />
      <img src="./Logo.png" alt="" aria-hidden className="na-logo-slice na-logo-slice-b" />
      <div className="na-logo-noise" aria-hidden />
    </div>
  )
}
