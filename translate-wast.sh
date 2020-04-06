JS=~/m-c/js/src/build-debug/dist/bin/js
for fn in $@; do
    $JS -e "var INPUT_FILE=\"$fn\";" $(dirname $0)/translate-wast.js
done
