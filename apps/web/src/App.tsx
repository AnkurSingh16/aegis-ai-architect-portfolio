import { useEffect, useState } from 'react';
import { portfolioProjects } from './content';
import Triage from './Triage';

type ApiHealth = { ok: boolean; service: string; mode: string };

export default function App() {
  const [apiStatus, setApiStatus] = useState(import.meta.env.PROD ? 'Public portfolio — API demo not exposed' : 'Checking local API…');
  useEffect(() => {
    if (import.meta.env.PROD) return;
    let active = true;
    fetch('/api/health')
      .then(async (response) => {
        if (!response.ok) throw new Error('API unavailable');
        return response.json() as Promise<ApiHealth>;
      })
      .then((data) => { if (active) setApiStatus(data.ok ? 'Local API connected' : 'API reported a problem'); })
      .catch(() => { if (active) setApiStatus('API offline — start npm run dev'); });
    return () => { active = false; };
  }, []);

  return (
    <div className="site">
      <header className="topbar wrap">
        <a href="#home" className="wordmark"><span className="logo">A</span> AEGIS <span>AI</span></a>
        <nav aria-label="Primary navigation">
          <a href="#project">Projects</a>
          <a href="#triage">Triage demo</a>
          <a href="#architecture">Architecture</a>
          <a href="https://github.com/AnkurSingh16/aegis-ai-architect-portfolio" target="_blank" rel="noreferrer">GitHub ↗</a>
        </nav>
      </header>
      <main id="home">
        <section className="hero wrap">
          <div className="eyebrow"><span className="signal" /> BUILDING RESPONSIBLE ENTERPRISE AI</div>
          <h1>AI systems that deserve <em>trust.</em></h1>
          <p className="lead">A hands-on engineering leadership portfolio focused on trustworthy AI, platform architecture, and measurable delivery excellence.</p>
          <div className="actions"><a className="primary" href="#project">Explore the work →</a><a className="secondary" href="#architecture">Architecture principles</a></div>
          <div className="status"><span className="status-dot" /> {apiStatus}<span className="divider">|</span> <span>Starter environment • synthetic demo only</span></div>
        </section>
        <section id="project" className="projects wrap">
          <div className="section-top"><p className="eyebrow">SELECTED WORK</p><h2>Designed to operate at scale.</h2></div>
          <div className="cards">
            {portfolioProjects.map((project) => <article className="project-card" key={project.title}>
              <p className="tag">{project.tag}</p><h3>{project.title}</h3><p className="description">{project.summary}</p>
              <div className="chips">{project.capabilities.map((capability) => <span key={capability}>{capability}</span>)}</div>
            </article>)}
          </div>
        </section>
        <Triage />
        <section id="architecture" className="principles wrap">
          <div><p className="eyebrow">ENGINEERING APPROACH</p><h2>Intentional quality.<br />Not just a polished demo.</h2></div>
          <div className="principle-list">
            <p><strong>01 — Secure by design.</strong> Least privilege, identity-aware authorization and tenant boundaries.</p>
            <p><strong>02 — Measurable outcomes.</strong> Regression tests, coverage, AI evaluations and service-level objectives.</p>
            <p><strong>03 — Governed releases.</strong> Human approval for risky actions, peer review and CI/CD gates.</p>
          </div>
        </section>
      </main>
      <footer className="wrap">Aegis AI — engineering portfolio foundation. Synthetic examples; active development.</footer>
    </div>
  );
}
