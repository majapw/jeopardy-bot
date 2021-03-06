import moment from 'moment';
import dehumanize from 'dehumanize-date';
import {Schema, model} from 'mongoose';
import {DiceCoefficient, JaroWinklerDistance} from 'natural';

import {generateGame} from '../japi';
import * as config from '../config';

export const schema = new Schema({
  categories: [{
    id: {
      type: Number,
      required: true
    },
    title: {
      type: String,
      required: true
    }
  }],

  challenge: {
    active: {
      type: String,
      default: ''
    },
    started: {
      type: Date
    },
    question: {
      type: Number
    },
    guesses: [{
      contestant: {
        type: String
      },
      guess: {
        type: String
      }
    }],
    votes: [{
      contestant: {
        type: String,
        required: true
      },
      correct: {
        type: Boolean,
        required: true
      }
    }]
  },

  // Information for the daily double:
  dailyDouble: {
    // The user that the daily double is currently assigned to:
    contestant: {
      type: String
    },
    // The wager of the daily double:
    wager: {
      type: Number,
      // Wager must be at least 5:
      min: 5
    }
  },

  channel_id: {
    type: String,
    required: true
  },

  lastCategory: {
    type: Number
  },

  activeQuestion: {
    type: Number
  },

  questionStart: {
    type: Date
  },

  contestantAnswers: {
    type: Array,
    default: []
  },

  questions: [{
    id: {
      type: Number,
      required: true
    },
    answer: {
      type: String,
      required: true
    },
    question: {
      type: String,
      required: true
    },
    value: {
      type: Number,
      required: true
    },
    answered: {
      type: Boolean,
      default: false
    },
    dailyDouble: {
      type: Boolean,
      default: false
    },
    category_id: {
      type: Number,
      required: true
    }
  }]
});

// Gets the clue with the timeout:
schema.methods.liveClue = function() {
  const clue = this.getClue();
  // There's no active question if we've timed out:
  if (this.isTimedOut()) {
    return false;
  }
  return clue;
};

schema.methods.isDailyDouble = function() {
  const clue = this.getClue();
  return clue.dailyDouble;
};

schema.methods.isChallengeStarted = function() {
  return this.challenge.active && this.challenge.started && moment().isBefore(moment(this.challenge.started).add(config.CHALLENGE_TIMEOUT, 'seconds'));
};

schema.methods.startChallenge = async function({contestant}) {
  const lastGuess = this.challenge.guesses.find(guess => guess.contestant === contestant.slackid);
  if (!this.liveClue() && !this.challenge.active && this.challenge.question && lastGuess) {
    this.challenge.active = lastGuess.contestant;
    this.challenge.started = Date.now();
    await this.save();
    return {
      guess: lastGuess.guess,
      answer: this.questions.find(question => question.id === this.challenge.question).answer
    };
  } else {
    throw new Error('bad values');
  }
};

schema.methods.endChallenge = async function() {
  const slackid = this.challenge.active;
  const votes = this.challenge.votes;

  // Clean out some values:
  this.challenge.active = undefined;
  this.challenge.votes = [];
  this.challenge.guesses = [];
  this.challenge.question = undefined;

  if (votes.length < config.CHALLENGE_MIN) {
    throw new Error('min');
  }
  const yesVotes = this.challenge.votes.map(vote => vote.correct ? 1 : 0).reduce((prev, curr) => {
    return prev + curr;
  });

  if ((yesVotes / votes.length) >= config.CHALLENGE_THRESHOLD) {
    const contestant = await this.model('Contestant').findOne({
      slackid
    });
    const {value} = this.questions.find(question => question.id === this.challenge.question);
    await contestant.correct({
      // Award twice the value, one to make up for the loss, and one for the new points:
      value: value * 2,
      channel_id: this.channel_id
    });

    return {
      channelScore: contestant.channelScore(this.channel_id)
    };
  } else {
    throw new Error('votes');
  }
};

schema.methods.isTimedOut = function() {
  return moment().isAfter(moment(this.questionStart).add(config.CLUE_TIMEOUT, 'seconds'));
};

schema.methods.isComplete = function() {
  return !this.questions.some(question => !(question && question.answered));
};

schema.methods.answered = function(id) {
  return this.contestantAnswers.some(i => i === id);
};

// End all games:
schema.methods.end = async function() {
  const contestants = await this.model('Contestant').find({
    scores: {
      $elemMatch: {
        channel_id: this.channel_id
      }
    }
  });
  await Promise.all(
    contestants.sort((a, b) => {
      const {value: aScore} = a.channelScore(this.channel_id);
      const {value: bScore} = b.channelScore(this.channel_id);
      if (bScore > aScore) {
        return 1;
      }
      if (aScore > bScore) {
        return -1;
      }
      return 0;
    }).map((contestant, i) => {
      let won = false;
      let lost = false;
      // If the game is complete, the player may have won or lost:
      if (this.isComplete()) {
        if (i === 0) {
          // If we're first, then we have the highest score:
          won = true;
        } else {
          // Otherwise, we lost this game:
          lost = true;
        }
      }
      // Mark the contestant game as ended:
      return contestant.endGame({
        channel_id: this.channel_id,
        won,
        lost
      });
    })
  );
  return this.remove();
};

// Grab the active game for the channel:
schema.statics.forChannel = function({channel_id}) {
  return this.findOne({channel_id});
};

// Start a new game:
schema.statics.start = async function({channel_id}) {
  const game = await this.forChannel({channel_id});

  // Clear out existing (ended) games:
  if (game && !game.isComplete()) {
    throw new Error('A game is already in progress.');
  } else if (game) {
    await game.end();
  }

  // Grab a random episode from the API:
  const episode = await generateGame();
  // Extract the questions and categories:
  const {clues: questions, categories} = episode.roundOne;

  return this.create({
    channel_id,
    categories,
    questions
  });
};

// Gets the clue without the timeout:
schema.methods.getClue = function() {
  return this.questions.find(q => q.id === this.activeQuestion);
};

schema.methods.getCategory = function() {
  const clue = this.getClue();
  return this.categories.find(cat => cat.id === clue.category_id);
};

// Get a new clue for a given value and title.
schema.methods.newClue = async function({category, value, contestant}) {
  if (this.isChallengeStarted()) {
    throw new Error('challenge');
  }

  if (category === '--same-lowest--' && this.lastCategory) {
    // These questions are internally value-sorted lowest-to-highest.
    const lowestValueClue = this.questions.find(question => {
      return (question.category_id === this.lastCategory && !question.answered);
    });
    if (lowestValueClue) {
      category = '--same--';
      value = lowestValueClue.value;
    }
  }

  value = parseInt(value, 10);
  if (!config.VALUES.includes(value)) {
    throw new RangeError('value');
  }
  if (this.liveClue()) {
    throw new Error('already active');
  }
  // If there's an active clue that has timed out, let's go ahead and time it out:
  if (this.getClue()) {
    await this.answer();
  }

  // Handle asking for the same category:
  let selectedCategory;
  if (category === '--same--' && this.lastCategory) {
    selectedCategory = this.lastCategory;
  } else {
    const cc = this.categories.map(cat => {
      return {
        id: cat.id,
        rank: DiceCoefficient(cat.title, category)
      };
    }).sort((a, b) => {
      if (a.rank > b.rank) {
        return -1;
      } else if (b.rank > a.rank) {
        return 1;
      }
      return 0;
    }).filter(x => {
      return x.rank > 0.5;
    })[0];

    // If we can extract a category from the input, let's use it:
    if (cc) {
      selectedCategory = cc.id;
    }
  }

  // Invalid ask:
  if (!selectedCategory) {
    throw new RangeError('category');
  }

  const question = this.questions.find(q => {
    return (q.category_id === selectedCategory && q.value === value);
  });

  if (question.answered) {
    throw new Error('Question has already been answered.');
  }

  // If the question is a daily double, add in the contestant:
  if (question.dailyDouble) {
    this.dailyDouble.contestant = contestant;
  }

  // Reset the guesses:
  this.challenge.guesses = [];
  this.lastCategory = selectedCategory;
  this.activeQuestion = question.id;
  return this.save();
};

schema.methods.clueSent = function() {
  this.questionStart = Date.now();
  return this.save();
};

// Helper function to determine if something is just a raw number:
const isNumber = num => {
  return !isNaN(num);
};

schema.methods.guess = async function({contestant, guess}) {
  if (this.isChallengeStarted()) {
    throw new Error('challenge');
  }
  if (!this.activeQuestion) {
    throw new Error('clue');
  }
  if (this.isTimedOut()) {
    throw new Error('timeout');
  }
  if (this.answered(contestant.slackid)) {
    throw new Error('contestant');
  }
  // Daily doubles can only be answered by the user that selected them
  if (this.isDailyDouble() && this.dailyDouble.contestant !== contestant.slackid) {
    throw new Error('dailydouble');
  }
  if (this.isDailyDouble() && !this.dailyDouble.wager) {
    throw new Error('wager');
  }

  // This contestant has now guessed:
  this.contestantAnswers.push(contestant.slackid);

  // Get the answers:
  const answers = this.liveClue().answer.split(/\(|\)/).filter(n => n);
  answers.push(answers.join(' '));
  const correctAnswer = answers.some(answer => {
    // Number matching:
    if (isNumber(answer)) {
      // Numbers much be identical:
      return parseInt(answer, 10) === parseInt(guess, 10);
    }

    // Date matching:
    const answerDate = dehumanize(answer);
    if (answerDate) {
      const guessDate = dehumanize(guess);
      return moment(answerDate).isSame(moment(guessDate));
    }

    // String matching:
    const similarity = DiceCoefficient(guess, answer);
    if (similarity >= config.ACCEPTED_SIMILARITY) {
      return true;
    } else if (similarity >= config.JARO_KICKER) {
      const jaroSimilarity = JaroWinklerDistance(guess, answer);
      return jaroSimilarity >= config.JARO_SIMILARITY;
    } else {
      return false;
    }
  });
  if (!correctAnswer) {
    // Add the guess to allow for a challenge:
    this.challenge.guesses.push({
      guess,
      contestant: contestant.slackid
    });
  }
  await this.save();
  return correctAnswer;
};

schema.methods.answer = function() {
  this.questions.some(q => {
    if (this.activeQuestion === q.id) {
      q.answered = true;
      return true;
    }
  });

  // Set up the ruling to be started:
  this.challenge.votes = [];
  this.challenge.active = '';
  this.challenge.question = this.activeQuestion;

  // Clear out all of the data for this question:
  this.contestantAnswers = [];
  this.activeQuestion = undefined;
  this.questionStart = undefined;
  this.dailyDouble = {};

  return this.save();
};

export const Game = model('Game', schema);
