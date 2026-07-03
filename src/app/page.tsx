export default function Home() {
  return (
    <main style={{ maxWidth: 820, margin: "0 auto", padding: 32, lineHeight: 1.55 }}>
      <h1 style={{ color: "#e8a838", letterSpacing: "0.08em" }}>◆ EDGE LAB</h1>
      <p style={{ color: "#8b95a5" }}>
        Paper-trading платформа для AI-анализа live-ставок на prediction-маркетах.
        Этап 1–2 (фундамент данных) реализован. UI по макету — следующим заходом.
      </p>

      <h3 style={{ color: "#7fb4e8" }}>Что готово</h3>
      <ul style={{ color: "#c3cad6" }}>
        <li>Схема БД по ТЗ §2 (node:sqlite, без внешнего сервера)</li>
        <li>Денежная модель + инварианты §9 (казна → турнир → доли)</li>
        <li>Извлечение порогов из промта и сайзинг ставок кодом (§3.2, §9.6)</li>
        <li>Settlement, CLV, Brier, калибровка (§3.4, §2.14)</li>
        <li>Серверный клиент котировок Polymarket с graceful-фолбэком (§5.1)</li>
        <li>Абстракция LLM-провайдеров с ключами из env (§5.3, §9.9)</li>
      </ul>

      <h3 style={{ color: "#7fb4e8" }}>Проверка</h3>
      <pre
        style={{
          background: "#1a2029",
          border: "1px solid #2c3543",
          borderRadius: 10,
          padding: 14,
          overflowX: "auto",
        }}
      >{`npm install
npm test          # модульные тесты бизнес-логики
npm run db:seed   # наполнить локальную БД данными из макета
npm run smoke     # прогон одного матча: анализ → сайзинг → settlement`}</pre>

      <p style={{ color: "#8b95a5" }}>
        Здоровье данных: <a href="/api/health" style={{ color: "#70b56a" }}>/api/health</a>
      </p>
    </main>
  );
}
