import mongoose from 'mongoose';
import express from 'express';
import bodyParser from 'body-parser';
import Pageres from 'pageres';
import fetch from 'node-fetch';
import { join } from 'path';
import { dust } from 'adaro';

import responses from './responses';
import { upload } from './upload';
import { MessageReader } from './MessageReader';

import { Game } from './models/Game';
import { Person } from './models/Person';

export const commands = {
  new() {
    return Game.start()
      .then(() => getImageUrl('board'))
      .then((url) => `Let's get this game started! ${url}`)
      .catch((e) => 'It looks like a game is already in progress! You need to finish or end that one first before starting a new game.');
  },
  end() {
    return Game.end()
      .then(() => `Alright, I've ended that game for you. You can always start a new game by typing "new game".`);
  },
  help() {
    return responses.help;
  }
};

async function command(message) {
  return commands[message.command](message);
};

const MONGO_URL = process.env.MONGOLAB_URI || 'mongodb://localhost/jeopardy'
mongoose.connect(MONGO_URL);

const port = process.env.PORT || 8000;

const app = express();

async function getImageUrl(file) {
  await fetch(`http://localhost:${port}/${file}.png`);
  let url = await upload(join(__dirname, 'images', `${file}.png`));
  return url;
};

const options = {
  helpers: [
    (dust) => {
      dust.helpers.Card = (chunk, context, bodies, params) => {
        const questions = context.get('questions');
        const value = context.resolve(params.value);
        const id = context.resolve(params.id);
        var question = questions.find((q) => {
          return q.value === value && q.category_id === id;
        });
        if (question.answered) {
          chunk.write('');
        } else {
          chunk.write(`<span class="dollar">$</span>${value}`);
        }
      }
    }
  ]
}

app.engine('dust', dust(options));
app.set('view engine', 'dust');
app.set('views', join(__dirname, 'views'));

const username = 'Jeopardy';

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.post('/command', (req, res) => {
  // Ignore messages from ourself:
  if (req.body.username === username) return;

  console.log('Processing...', req.body);

  const message = MessageReader.parse(req.body.text);
  console.log('command', message);
  if (message && message.command) {
    command(message).then(text => {
      res.json({
        username,
        text
      });
    });
  } else {
    // Send nothing:
    res.end();
  }
});

app.get('/board', (req, res) => {
  Game.activeGame().then(game => {
    res.render('board', {
      categories: game.categories,
      questions: game.questions,
      values: [200, 400, 600, 800, 1000]
    });
  });
});

app.get('/clue', (req, res) => {
  Game.activeGame().then(game => {
    res.render('clue', {
      clue: game.activeClue
    });
  });
});

app.get('/getclue/:title/:value', (req, res) => {
  Game.getClue(req.params.title, req.params.value).then(clue => {
    res.send('Got clue');
  });
});

app.get('/guess/:whatis', (req, res) => {
  Game.guess(req.params.whatis).then(valid => {
    res.send(valid);
  });
});

app.get('/answer', (req, res) => {
  Game.answer().then(() => {
    res.send('done');
  });
});

app.get('/startgame', (req, res) => {
  Game.start().then(() => {
    res.send('ok');
  }).catch((e) => {
    res.send('no');
  });
});

app.get('/endgame', (req, res) => {
  Game.end().then(() => {
    res.send('ok');
  });
});

app.get('/clue.png', (req, res) => {
  var pageres = new Pageres()
    .src(`localhost:${port}/clue`, ['1000x654'], {crop: false, filename: 'clue'})
    .dest(join(__dirname, 'images'));

  pageres.run(function (err, items) {
    res.sendFile(join(__dirname, 'images', 'clue.png'));
  });
});

app.get('/board.png', (req, res) => {
  var pageres = new Pageres()
    .src(`localhost:${port}/board`, ['1000x654'], {crop: false, filename: 'board'})
    .dest(join(__dirname, 'images'));

  pageres.run(function (err, items) {
    res.sendFile(join(__dirname, 'images', 'board.png'));
  });
});

app.listen(port, () => {
  console.log(`Jeopardy Bot listening on port ${port}`);
});