all: build

.PHONY: all build install clean publish install-zip legacy-build g44 publish-g44 test-prefs test-prefs-g44 xml-lint pretty todo

build:
	glib-compile-schemas --strict --targetdir=schemas/ schemas

install: publish
	$(MAKE) install-zip

clean:
	rm -rf ./build
	rm -f schemas/gschemas.compiled

publish:
	echo "publishing..."
	rm -rf build
	mkdir ./build
	cp LICENSE ./build
	cp *.js ./build
	cp metadata.json ./build
	cp stylesheet.css ./build
	cp CHANGELOG.md ./build
	cp README.md ./build
	cp -R schemas ./build
	cp -R ui ./build
	cp -R apps ./build
	cp -R preferences ./build
	cp -R effects ./build
	cp -R themes ./build
	rm -f ./dash2dock-lite@icedman.github.com.zip
	rm -rf build/schemas/gschemas.compiled
	rm -rf build/*_.js
	rm -rf build/imports*.js
	cd build ; \
	zip -qr ../dash2dock-lite@icedman.github.com.zip .

install-zip:
	echo "installing zip..."
	gnome-extensions install --force dash2dock-lite@icedman.github.com.zip

test-prefs:
	gnome-extensions prefs dash2dock-lite@icedman.github.com

legacy-build: build
	rm -rf ./build
	mkdir -p ./build
	mkdir -p ./build/apps
	mkdir -p ./build/effects
	mkdir -p ./build/preferences
	python3 ./tools/transpile.py
	cp -R ./schemas ./build
	cp -R ./themes ./build
	cp -R ./ui ./build
	cp ./effects/*.glsl ./build/effects
	cp ./LICENSE* ./build
	cp ./CHANGELOG* ./build
	cp ./README* ./build
	cp ./stylesheet.css ./build

g44: publish-g44
	$(MAKE) install-zip

publish-g44: legacy-build
	echo "publishing..."
	rm -f ./dash2dock-lite@icedman.github.com.zip
	rm -f build/schemas/gschemas.compiled
	cd build ; \
	zip -qr ../dash2dock-lite@icedman.github.com.zip .

test-prefs-g44: g44
	gnome-extensions prefs dash2dock-lite@icedman.github.com

xml-lint:
	cd ui ; \
	find . -name "*.ui" -type f -exec xmllint --output '{}' --format '{}' \;

pretty: xml-lint
	rm -rf ./build/*
	prettier --single-quote --write "**/*.js"

todo:
	python3 ./tools/todo.py > ./TODO.md
