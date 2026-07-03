import type { ReactNode } from "react";

export const metadata = {
  title: "EDGE LAB",
  description: "Paper-trading platform for AI analysis of live prediction-market bets",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body
        style={{
          fontFamily: "'Inter', system-ui, sans-serif",
          background: "#12161d",
          color: "#e6e9ef",
          margin: 0,
        }}
      >
        {children}
      </body>
    </html>
  );
}
