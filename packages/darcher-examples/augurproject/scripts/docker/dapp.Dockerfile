FROM ubuntu:20.04

ENV NODE_VERSION=10.23.0

RUN apt update; apt install -y curl git
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.37.2/install.sh | bash
ENV NVM_DIR=/root/.nvm
RUN . "$NVM_DIR/nvm.sh" && nvm install ${NODE_VERSION}
RUN . "$NVM_DIR/nvm.sh" && nvm use v${NODE_VERSION}
RUN . "$NVM_DIR/nvm.sh" && nvm alias default v${NODE_VERSION}
ENV PATH="/root/.nvm/versions/node/v${NODE_VERSION}/bin/:${PATH}"
RUN npm i -g yarn

# context path should be augurproject

COPY ./scripts/docker/start-dapp.sh /
COPY ./augur /augur

RUN chmod +x /start-dapp.sh
RUN cd /augur && yarn && yarn build

RUN rm -rf /augur/.git
RUN git config --global user.email "you@example.com"
RUN git config --global user.name "Your Name"
RUN cd /augur && git init && git add --all && git commit -m "init"
ENTRYPOINT ["/start-dapp.sh"]
EXPOSE 8080
