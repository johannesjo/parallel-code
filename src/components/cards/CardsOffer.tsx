import { answerCardsOffer, openSettingsTab } from '../../store/store';
import './cards.css';

/**
 * The one-time offer of the free cards to an install from before cards. Their
 * header only changes once the user says yes; every answer closes it for good.
 */
export function CardsOffer() {
  return (
    <div class="cards-offer" role="region" aria-label="Cards are here">
      <strong>Cards are here</strong>
      <span>
        Turn on Diff size, Branch health and Confidence? They're free and nothing leaves your
        machine.
      </span>
      <div class="cards-offer-actions">
        <button type="button" class="btn-secondary" onClick={() => answerCardsOffer(false)}>
          Not now
        </button>
        <button
          type="button"
          class="btn-secondary"
          onClick={() => {
            answerCardsOffer(false);
            openSettingsTab('cards');
          }}
        >
          Choose in settings
        </button>
        <button type="button" class="btn-primary" onClick={() => answerCardsOffer(true)}>
          Turn on
        </button>
      </div>
    </div>
  );
}
