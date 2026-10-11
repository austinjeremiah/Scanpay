export default function Cta() {
  return (
    <section className="cta-section">
      <div className="section-wrap">
        <div className="container-2nd">
          <div className="cta-wrapper">
            <div scale-up="True" className="cta-banner-box">
              <img sizes="100vw" srcSet="/assets/6a93c65c838ecd2fa17f58c0_cta_banner_p_500.avif 500w, /assets/6a93c65c838ecd2fa17f58c0_cta_banner_p_800.avif 800w, /assets/6a93c65c838ecd2fa17f58c0_cta_banner_p_1080.avif 1080w, /assets/6a93c65c838ecd2fa17f58c0_cta_banner.avif 1380w" alt="Banner" src="/assets/6a93c65c838ecd2fa17f58c0_cta_banner.avif" loading="lazy" className="cta-banner" />
            </div>
            <div fade-anim="True" className="cta-title-box">
              <h2 className="cta-title">
                Stay in the loop as ScanPay Guard goes live on Monad
              </h2>
            </div>
            <div fade-anim="True" className="cta-newsletter-wrap">
              <div className="cta-newsletter-title">
                OUR NEWSLETTER
              </div>
              <div className="cta-newsletter-box">
                <div id="Cta-Newsletter-Form-Block" className="cta-newsletter-form-block w-form">
                  <form id="Cta-Newsletter-Form" name="email-form" data-name="Email Form" method="get" className="cta-newsletter-form" data-wf-page-id="6a901794a3ca5e0a74527ddb" data-wf-element-id="f012f319-a8b5-fc35-20e6-c93d784542b1" data-turnstile-sitekey="0x4AAAAAAAQTptj2So4dx43e">
                    <label htmlFor="Cta-Newsletter-Form-Email" className="display-none">
                      {"[enter your email]"}
                    </label>
                    <input className="cta-newsletter-form-input w-input" maxLength={256} name="Cta-Newsletter-Form-Email" data-name="Cta-Newsletter-Form-Email" placeholder="[enter your email]" type="email" id="Cta-Newsletter-Form-Email" required />
                    <div className="cta-newsletter-form-button-box">
                      <input type="submit" data-wait="Please wait..." id="Cta-Newsletter-Form-Button" className="cta-newsletter-form-button w-button" value="" />
                      <img loading="lazy" src="/assets/6a93d0b5d674c548a8d63423_button_arrow_2.svg" alt="Arrow" className="cta-newsletter-form-button-arrow" />
                    </div>
                  </form>
                  <div className="cta-newsletter-form-success w-form-done">
                    <div className="cta-newsletter-form-success-text">
                      Thank you! Your submission has been received!
                    </div>
                  </div>
                  <div className="w-form-fail">
                    <div>
                      Oops! Something went wrong while submitting the form.
                    </div>
                  </div>
                </div>
                <p className="cta-newsletter-text">
                  Get build updates on passkey payments, stablecoin routes and on-chain receipts. No spam.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
