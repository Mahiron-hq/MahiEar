import { Footer, Link } from './Footer';

export function NotFound() {
  return (
    <div class="screen error-screen">
      <header class="brand">
        <Link to={{ name: 'home' }} class="wordmark">
          MahiEar
        </Link>
      </header>
      <section class="error-body">
        <p class="error-code tabular">404</p>
        <h1 class="error-title">Страница не найдена</h1>
        <p class="error-text">Такого адреса на сайте нет. Возможно, ссылка устарела или в ней опечатка.</p>
        <Link to={{ name: 'home' }} class="btn btn-primary btn-lg">
          На главную
        </Link>
      </section>
      <Footer />
    </div>
  );
}
